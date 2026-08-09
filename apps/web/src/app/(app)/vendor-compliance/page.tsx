'use client';

import { useMemo, useState } from 'react';
import {
  Loader2, AlertCircle, ShieldCheck, ShieldAlert, X, Ban, CheckCircle2,
  ArrowUp, ArrowDown, Sparkles, Clock, FileWarning, type LucideIcon,
} from 'lucide-react';
import { clsx } from 'clsx';
import { formatMoney } from '@meritbooks/shared';
import { useQuery, addToast } from '@/hooks';
import { api } from '@/lib/api-client';
import { PageHeader, EmptyState } from '@/components/ui';
import { VendorComplianceTabs } from './vendor-compliance-tabs';

type DocState = 'valid' | 'expiring' | 'expired' | 'missing' | 'pending';
type OverrideType = 'ONE_TIME' | 'TEMPORARY' | 'PERMANENT';
type Tier = 'auto' | 'review' | 'escalate';
type RiskPriority = 'low' | 'medium' | 'high' | 'critical';
type SortKey = 'risk' | 'vendor' | 'exposure';
type FilterKey = 'all' | 'onHold' | 'atRisk' | 'overrides' | 'compliant';

interface Doc { id: string; doc_type: string; status: string; expiration_date: string | null; state: DocState }
interface Issue { docType: string; label: string; state: string }
interface ActiveOverride { id: string; type: OverrideType; reason: string; endDate: string | null }
interface Risk {
  score: number; confidence: number; tier: Tier; priority: RiskPriority;
  worstState: DocState | 'none'; reason: string; tierReason: string; chaseRecommended: boolean;
}
interface Row {
  vendorId: string; vendorName: string; compliant: boolean; onHold: boolean;
  issues: Issue[]; docs: Doc[]; activeOverride: ActiveOverride | null; openBillsCents: number; risk: Risk;
}
interface DocCounts { valid: number; expiring: number; expired: number; missing: number; pending: number }
interface Summary {
  total: number; onHold: number; withOverride: number; compliant: number; blockedBalanceCents: number;
  atRisk: number; escalations: number; docCounts: DocCounts;
}
interface Overview { rows: Row[]; summary: Summary }

const DOC_SHORT: Record<string, string> = { W9: 'W-9', GL_COI: 'GL COI', WC_COI: 'WC COI', WC_EXEMPTION: 'WC Exempt' };

const DOC_STATE_CLS: Record<DocState, string> = {
  valid: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
  expiring: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
  expired: 'bg-red-500/10 text-red-400 border-red-500/20',
  missing: 'bg-red-500/10 text-red-400 border-red-500/20',
  pending: 'bg-slate-500/10 text-slate-400 border-slate-500/20',
};
const OVERRIDE_LABEL: Record<OverrideType, string> = { ONE_TIME: 'One-time', TEMPORARY: 'Temporary', PERMANENT: 'Permanent' };

const PRIORITY_CLS: Record<RiskPriority, string> = {
  critical: 'bg-red-500/10 text-red-400 border-red-500/20',
  high: 'bg-amber-500/10 text-amber-300 border-amber-500/20',
  medium: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
  low: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
};
const TIER_LABEL: Record<Tier, string> = { auto: 'Auto', review: 'Review', escalate: 'Escalate' };

const FILTERS: { key: FilterKey; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'onHold', label: 'On hold' },
  { key: 'atRisk', label: 'At risk' },
  { key: 'overrides', label: 'Overrides' },
  { key: 'compliant', label: 'Compliant' },
];

const fmtDate = (d: string | null) =>
  d ? new Date(d + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' }) : null;

export default function VendorCompliancePage() {
  const { data, isLoading, error, refetch } = useQuery<Overview>('/api/vendor-compliance');
  const [grantFor, setGrantFor] = useState<Row | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [filter, setFilter] = useState<FilterKey>('all');
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'risk', dir: 'desc' });

  const allRows = data?.rows ?? [];
  const s = data?.summary;

  const counts = useMemo(() => {
    const c: Record<FilterKey, number> = {
      all: allRows.length,
      onHold: allRows.filter((r) => r.onHold).length,
      atRisk: allRows.filter((r) => !r.compliant).length,
      overrides: allRows.filter((r) => r.activeOverride).length,
      compliant: allRows.filter((r) => r.compliant).length,
    };
    return c;
  }, [allRows]);

  const rows = useMemo(() => {
    let list = allRows;
    if (filter === 'onHold') list = list.filter((r) => r.onHold);
    else if (filter === 'atRisk') list = list.filter((r) => !r.compliant);
    else if (filter === 'overrides') list = list.filter((r) => r.activeOverride);
    else if (filter === 'compliant') list = list.filter((r) => r.compliant);

    const dir = sort.dir === 'asc' ? 1 : -1;
    return [...list].sort((a, b) => {
      if (sort.key === 'vendor') return dir * a.vendorName.localeCompare(b.vendorName);
      if (sort.key === 'exposure') return dir * (a.openBillsCents - b.openBillsCents);
      // risk
      return dir * (a.risk.score - b.risk.score || a.openBillsCents - b.openBillsCents);
    });
  }, [allRows, filter, sort]);

  const toggleSort = (key: SortKey) =>
    setSort((prev) => (prev.key === key ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: key === 'vendor' ? 'asc' : 'desc' }));

  const runMaintenance = async () => {
    setRunning(true);
    const res = await api.post<{ expired: number; chased: number; assessed: number; escalated: number; queued: number }>(
      '/api/vendor-compliance', { action: 'run_maintenance' },
    );
    setRunning(false);
    if (res.error) { addToast('error', res.error.error); return; }
    const d = res.data;
    const queued = d?.queued ?? 0;
    addToast(
      'success',
      `AI compliance sweep: ${d?.expired ?? 0} expired, ${d?.chased ?? 0} chase reminders, ${d?.assessed ?? 0} vendors assessed` +
        (queued > 0 ? ` — ${queued} escalated to Needs Attention` : ''),
    );
    refetch();
  };

  const releaseOverride = async (r: Row) => {
    if (!r.activeOverride) return;
    const reason = window.prompt(`End the ${OVERRIDE_LABEL[r.activeOverride.type]} override for ${r.vendorName}? Reason:`);
    if (!reason || reason.trim().length < 3) return;
    setBusy(r.vendorId);
    const res = await api.post('/api/vendor-compliance', { action: 'release_override', override_id: r.activeOverride.id, reason: reason.trim() });
    setBusy(null);
    if (res.error) { addToast('error', res.error.error); return; }
    addToast('success', `Override ended — ${r.vendorName} back on hold`);
    refetch();
  };

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <PageHeader
        title="Vendor Compliance"
        description="The AI tracks each vendor's W-9 and insurance certificates, scores compliance risk, and tees up chase actions. Vendors with a missing or expired document are automatically blocked from payment until cured or overridden."
        actions={
          <button className="btn btn-secondary btn-sm" onClick={runMaintenance} disabled={running}>
            {running ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />} Run AI compliance sweep
          </button>
        }
      />

      <div className="mb-6">
        <VendorComplianceTabs />
      </div>

      {isLoading && <div className="flex items-center justify-center py-20 text-slate-500"><Loader2 className="animate-spin" size={20} /></div>}
      {error && !isLoading && (
        <div className="card p-6 text-center">
          <AlertCircle className="mx-auto mb-2 text-red-400" size={20} />
          <p className="text-sm text-red-400">{error}</p>
          <button className="btn btn-secondary btn-sm mt-3" onClick={() => refetch()}>Try again</button>
        </div>
      )}

      {!isLoading && !error && data && (
        <div className="space-y-6">
          {s && (
            <>
              {/* Document-state strip */}
              <div className="grid gap-3 grid-cols-2 sm:grid-cols-4">
                <SummaryCard label="Compliant vendors" value={`${s.compliant}/${s.total}`} tone="emerald" icon={ShieldCheck} />
                <SummaryCard label="Expiring soon (docs)" value={String(s.docCounts.expiring)} tone={s.docCounts.expiring > 0 ? 'amber' : 'muted'} icon={Clock} />
                <SummaryCard label="Expired (docs)" value={String(s.docCounts.expired)} tone={s.docCounts.expired > 0 ? 'red' : 'muted'} icon={FileWarning} />
                <SummaryCard label="Missing (docs)" value={String(s.docCounts.missing)} tone={s.docCounts.missing > 0 ? 'red' : 'muted'} icon={FileWarning} />
              </div>
              {/* Enforcement strip */}
              <div className="grid gap-3 grid-cols-2 sm:grid-cols-4">
                <SummaryCard label="On payment hold" value={String(s.onHold)} tone={s.onHold > 0 ? 'red' : 'muted'} icon={ShieldAlert} />
                <SummaryCard label="Blocked A/P balance" value={formatMoney(s.blockedBalanceCents)} tone={s.blockedBalanceCents > 0 ? 'amber' : 'muted'} />
                <SummaryCard label="Escalated to review" value={String(s.escalations)} tone={s.escalations > 0 ? 'indigo' : 'muted'} icon={Sparkles} />
                <SummaryCard label="Active overrides" value={String(s.withOverride)} tone="neutral" />
              </div>
            </>
          )}

          {allRows.length === 0 ? (
            <EmptyState
              icon={ShieldCheck}
              title="No vendors tracking compliance documents"
              description="Add W-9 / COI documents on a vendor to bring them under compliance enforcement and AI risk scoring."
            />
          ) : (
            <>
              {/* Filter chips */}
              <div className="flex flex-wrap items-center gap-1.5">
                {FILTERS.map((f) => (
                  <button
                    key={f.key}
                    onClick={() => setFilter(f.key)}
                    className={clsx(
                      'inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors',
                      filter === f.key
                        ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400'
                        : 'border-slate-800 bg-slate-800/30 text-slate-400 hover:text-slate-200',
                    )}
                  >
                    {f.label}
                    <span className={clsx('rounded px-1.5 py-0.5 font-mono text-[10px]', filter === f.key ? 'bg-emerald-500/20' : 'bg-slate-700/50 text-slate-400')}>
                      {counts[f.key]}
                    </span>
                  </button>
                ))}
              </div>

              {rows.length === 0 ? (
                <div className="card p-10 text-center text-sm text-slate-400">No vendors match this filter.</div>
              ) : (
                <div className="card overflow-hidden">
                  <table className="w-full text-sm">
                    <thead className="text-2xs uppercase tracking-wide text-slate-500 border-b border-slate-800">
                      <tr>
                        <SortHeader label="Vendor" active={sort.key === 'vendor'} dir={sort.dir} onClick={() => toggleSort('vendor')} />
                        <SortHeader label="AI risk" active={sort.key === 'risk'} dir={sort.dir} onClick={() => toggleSort('risk')} />
                        <th className="text-left font-medium px-4 py-2.5">Documents</th>
                        <th className="text-left font-medium px-4 py-2.5">Status</th>
                        <SortHeader label="Open A/P" active={sort.key === 'exposure'} dir={sort.dir} onClick={() => toggleSort('exposure')} align="right" />
                        <th className="px-4 py-2.5"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r) => (
                        <tr key={r.vendorId} className="border-b border-slate-800/60 last:border-0 align-top">
                          <td className="px-4 py-3">
                            <p className="text-slate-200 font-medium">{r.vendorName}</p>
                            <p className="text-2xs text-slate-500 mt-0.5 max-w-xs truncate" title={r.risk.reason}>{r.risk.reason}</p>
                          </td>
                          <td className="px-4 py-3">
                            <div className="flex flex-col gap-1">
                              <span className={clsx('inline-flex w-fit items-center gap-1 px-1.5 py-0.5 rounded border text-2xs font-medium capitalize', PRIORITY_CLS[r.risk.priority])}>
                                {r.risk.priority}
                              </span>
                              <span className="inline-flex w-fit items-center gap-1 text-2xs text-indigo-300" title={r.risk.tierReason}>
                                <Sparkles size={10} /> {TIER_LABEL[r.risk.tier]} · {Math.round(r.risk.confidence * 100)}%
                              </span>
                            </div>
                          </td>
                          <td className="px-4 py-3">
                            <div className="flex flex-wrap gap-1.5">
                              {r.docs.map((d) => (
                                <span
                                  key={d.id}
                                  className={clsx('inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-2xs font-medium', DOC_STATE_CLS[d.state])}
                                  title={d.expiration_date ? `Expires ${d.expiration_date}` : d.doc_type}
                                >
                                  {DOC_SHORT[d.doc_type] ?? d.doc_type}: {d.state}
                                  {d.expiration_date && (d.state === 'expiring' || d.state === 'expired') && (
                                    <span className="opacity-70 font-mono">· {fmtDate(d.expiration_date)}</span>
                                  )}
                                </span>
                              ))}
                            </div>
                          </td>
                          <td className="px-4 py-3">
                            {r.onHold ? (
                              <span className="inline-flex items-center gap-1.5 text-red-400 text-xs font-medium">
                                <ShieldAlert size={14} /> Payment hold
                              </span>
                            ) : r.activeOverride ? (
                              <span className="inline-flex items-center gap-1.5 text-amber-300 text-xs font-medium" title={r.activeOverride.reason}>
                                <ShieldAlert size={14} /> {OVERRIDE_LABEL[r.activeOverride.type]} override
                                {r.activeOverride.endDate && <span className="text-slate-500">· to {r.activeOverride.endDate}</span>}
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1.5 text-emerald-400 text-xs font-medium">
                                <CheckCircle2 size={14} /> Compliant
                              </span>
                            )}
                          </td>
                          <td className={clsx('px-4 py-3 text-right font-mono', r.onHold && r.openBillsCents > 0 ? 'text-amber-300' : 'text-slate-400')}>
                            {formatMoney(r.openBillsCents)}
                          </td>
                          <td className="px-4 py-3 text-right whitespace-nowrap">
                            {r.onHold && (
                              <button className="btn btn-secondary btn-sm" onClick={() => setGrantFor(r)}>Override</button>
                            )}
                            {r.activeOverride && (
                              <button className="btn btn-ghost btn-sm text-red-400 ml-1" onClick={() => releaseOverride(r)} disabled={busy === r.vendorId}
                                title="End override (back on hold)">
                                {busy === r.vendorId ? <Loader2 size={13} className="animate-spin" /> : <Ban size={13} />}
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {grantFor && (
        <GrantOverrideModal row={grantFor} onClose={() => setGrantFor(null)} onDone={() => { setGrantFor(null); refetch(); }} />
      )}
    </div>
  );
}

function SortHeader({ label, active, dir, onClick, align = 'left' }: { label: string; active: boolean; dir: 'asc' | 'desc'; onClick: () => void; align?: 'left' | 'right' }) {
  return (
    <th className={clsx('font-medium px-4 py-2.5', align === 'right' ? 'text-right' : 'text-left')}>
      <button onClick={onClick} className={clsx('inline-flex items-center gap-1 uppercase tracking-wide hover:text-slate-300', active ? 'text-slate-300' : 'text-slate-500')}>
        {label}
        {active && (dir === 'asc' ? <ArrowUp size={11} /> : <ArrowDown size={11} />)}
      </button>
    </th>
  );
}

function SummaryCard({ label, value, tone, icon: Icon }: {
  label: string; value: string;
  tone: 'red' | 'amber' | 'neutral' | 'muted' | 'emerald' | 'indigo';
  icon?: LucideIcon;
}) {
  const cls =
    tone === 'red' ? 'text-red-400' : tone === 'amber' ? 'text-amber-300' : tone === 'emerald' ? 'text-emerald-400'
    : tone === 'indigo' ? 'text-indigo-300' : tone === 'muted' ? 'text-slate-400' : 'text-white';
  return (
    <div className="card p-4">
      <p className="text-xs text-slate-500 flex items-center gap-1.5">{Icon && <Icon size={12} />} {label}</p>
      <p className={clsx('text-xl font-mono font-semibold mt-1', cls)}>{value}</p>
    </div>
  );
}

function GrantOverrideModal({ row, onClose, onDone }: { row: Row; onClose: () => void; onDone: () => void }) {
  const [type, setType] = useState<OverrideType>('ONE_TIME');
  const [reason, setReason] = useState('');
  const [endDate, setEndDate] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    setErr(null);
    if (reason.trim().length < 3) return setErr('A reason is required (it is recorded on the audit trail).');
    if (type === 'TEMPORARY' && !endDate) return setErr('Choose an end date for a temporary override.');
    setSaving(true);
    const res = await api.post('/api/vendor-compliance', {
      action: 'grant_override',
      vendor_id: row.vendorId,
      hold_type: type,
      reason: reason.trim(),
      end_date: type === 'TEMPORARY' ? endDate : undefined,
    });
    setSaving(false);
    if (res.error) { setErr(res.error.error); return; }
    addToast('success', `Override granted for ${row.vendorName}`);
    onDone();
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4" onClick={onClose}>
      <div className="card w-full max-w-md p-5" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-base font-semibold text-white">Override payment hold</h3>
          <button className="text-slate-500 hover:text-slate-300" onClick={onClose}><X size={18} /></button>
        </div>

        <p className="text-sm text-slate-400 mb-4">
          {row.vendorName} is on hold for: <span className="text-red-300">{row.issues.map((i) => `${i.label} ${i.state}`).join(', ')}</span>.
          An override lets payments through; it is logged with your name and reason.
        </p>

        <div className="space-y-3">
          <div>
            <label className="text-xs text-slate-400">Override type</label>
            <select className="input mt-1" value={type} onChange={(e) => setType(e.target.value as OverrideType)}>
              <option value="ONE_TIME">One-time (single payment, then re-holds)</option>
              <option value="TEMPORARY">Temporary (until a date)</option>
              <option value="PERMANENT">Permanent (until manually ended)</option>
            </select>
          </div>
          {type === 'TEMPORARY' && (
            <div>
              <label className="text-xs text-slate-400">Override until</label>
              <input type="date" className="input mt-1" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
            </div>
          )}
          <div>
            <label className="text-xs text-slate-400">Reason (required)</label>
            <input className="input mt-1" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. COI renewal in progress, approved by controller" />
          </div>
          {err && <div className="text-sm text-red-400 flex items-center gap-2"><AlertCircle size={14} /> {err}</div>}
        </div>

        <div className="flex justify-end gap-2 mt-5">
          <button className="btn btn-secondary btn-sm" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="btn btn-primary btn-sm" onClick={submit} disabled={saving}>
            {saving ? <Loader2 size={14} className="animate-spin" /> : null} Grant override
          </button>
        </div>
      </div>
    </div>
  );
}
