'use client';

import { useState } from 'react';
import { Loader2, AlertCircle, ShieldCheck, ShieldAlert, X, RefreshCw, Ban, CheckCircle2 } from 'lucide-react';
import { clsx } from 'clsx';
import { useQuery, addToast } from '@/hooks';
import { api } from '@/lib/api-client';
import { PageHeader, EmptyState } from '@/components/ui';

type DocState = 'valid' | 'expiring' | 'expired' | 'missing' | 'pending';
type OverrideType = 'ONE_TIME' | 'TEMPORARY' | 'PERMANENT';

interface Doc { id: string; doc_type: string; status: string; expiration_date: string | null; state: DocState }
interface Issue { docType: string; label: string; state: string }
interface ActiveOverride { id: string; type: OverrideType; reason: string; endDate: string | null }
interface Row {
  vendorId: string; vendorName: string; compliant: boolean; onHold: boolean;
  issues: Issue[]; docs: Doc[]; activeOverride: ActiveOverride | null; openBillsCents: number;
}
interface Summary { total: number; onHold: number; withOverride: number; compliant: number; blockedBalanceCents: number }
interface Overview { rows: Row[]; summary: Summary }

const fmt = (c: number) => (c / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const DOC_SHORT: Record<string, string> = { W9: 'W-9', GL_COI: 'GL COI', WC_COI: 'WC COI', WC_EXEMPTION: 'WC Exempt' };

const DOC_STATE_CLS: Record<DocState, string> = {
  valid: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
  expiring: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
  expired: 'bg-red-500/10 text-red-400 border-red-500/20',
  missing: 'bg-red-500/10 text-red-400 border-red-500/20',
  pending: 'bg-slate-500/10 text-slate-400 border-slate-500/20',
};
const OVERRIDE_LABEL: Record<OverrideType, string> = { ONE_TIME: 'One-time', TEMPORARY: 'Temporary', PERMANENT: 'Permanent' };

export default function VendorCompliancePage() {
  const { data, isLoading, error, refetch } = useQuery<Overview>('/api/vendor-compliance');
  const [grantFor, setGrantFor] = useState<Row | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  const rows = data?.rows ?? [];
  const s = data?.summary;

  const runMaintenance = async () => {
    setRunning(true);
    const res = await api.post<{ expired: number; chased: number }>('/api/vendor-compliance', { action: 'run_maintenance' });
    setRunning(false);
    if (res.error) { addToast('error', res.error.error); return; }
    addToast('success', `Compliance check: ${res.data?.expired ?? 0} expired, ${res.data?.chased ?? 0} chase reminders scheduled`);
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
        description="Vendors with a missing or expired W-9 or COI are automatically blocked from payment until cured or overridden."
        actions={
          <button className="btn btn-secondary btn-sm" onClick={runMaintenance} disabled={running}>
            {running ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />} Run compliance check
          </button>
        }
      />

      {isLoading && <div className="flex items-center justify-center py-20 text-slate-500"><Loader2 className="animate-spin" size={20} /></div>}
      {error && !isLoading && <div className="card p-4 flex items-center gap-2 text-red-400 text-sm"><AlertCircle size={16} /> {error}</div>}

      {!isLoading && !error && data && (
        <div className="space-y-6">
          {s && (
            <div className="grid gap-3 grid-cols-2 sm:grid-cols-4">
              <SummaryCard label="On payment hold" value={String(s.onHold)} tone={s.onHold > 0 ? 'red' : 'muted'} />
              <SummaryCard label="Blocked balance" value={fmt(s.blockedBalanceCents)} tone={s.blockedBalanceCents > 0 ? 'amber' : 'muted'} />
              <SummaryCard label="Active overrides" value={String(s.withOverride)} tone="neutral" />
              <SummaryCard label="Compliant" value={`${s.compliant}/${s.total}`} tone="emerald" />
            </div>
          )}

          {rows.length === 0 ? (
            <EmptyState
              icon={ShieldCheck}
              title="No vendors tracking compliance documents"
              description="Add W-9 / COI documents on a vendor to bring them under compliance enforcement."
            />
          ) : (
            <div className="card overflow-hidden">
              <table className="w-full text-sm">
                <thead className="text-2xs uppercase tracking-wide text-slate-500 border-b border-slate-800">
                  <tr>
                    <th className="text-left font-medium px-4 py-2.5">Vendor</th>
                    <th className="text-left font-medium px-4 py-2.5">Documents</th>
                    <th className="text-left font-medium px-4 py-2.5">Status</th>
                    <th className="text-right font-medium px-4 py-2.5">Open A/P</th>
                    <th className="px-4 py-2.5"></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.vendorId} className="border-b border-slate-800/60 last:border-0 align-top">
                      <td className="px-4 py-3 text-slate-200 font-medium">{r.vendorName}</td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap gap-1.5">
                          {r.docs.map((d) => (
                            <span key={d.id} className={clsx('inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-2xs font-medium', DOC_STATE_CLS[d.state])}
                              title={d.expiration_date ? `Expires ${d.expiration_date}` : undefined}>
                              {DOC_SHORT[d.doc_type] ?? d.doc_type}: {d.state}
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
                        {fmt(r.openBillsCents)}
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
        </div>
      )}

      {grantFor && (
        <GrantOverrideModal row={grantFor} onClose={() => setGrantFor(null)} onDone={() => { setGrantFor(null); refetch(); }} />
      )}
    </div>
  );
}

function SummaryCard({ label, value, tone }: { label: string; value: string; tone: 'red' | 'amber' | 'neutral' | 'muted' | 'emerald' }) {
  const cls = tone === 'red' ? 'text-red-400' : tone === 'amber' ? 'text-amber-300' : tone === 'emerald' ? 'text-emerald-400' : tone === 'muted' ? 'text-slate-400' : 'text-white';
  return (
    <div className="card p-4">
      <p className="text-xs text-slate-500">{label}</p>
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
