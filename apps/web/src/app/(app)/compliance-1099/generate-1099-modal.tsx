'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  X,
  Loader2,
  AlertCircle,
  CheckCircle2,
  ShieldAlert,
  FileSpreadsheet,
  FileText,
  FileCode2,
  Users,
  DollarSign,
  Wrench,
  Landmark,
} from 'lucide-react';
import { clsx } from 'clsx';
import { formatMoney } from '@meritbooks/shared';
import { api } from '@/lib/api-client';
import { addToast } from '@/hooks';

/**
 * Generate 1099s flow (read-only assembly; NO IRS transmit — canon §3). The user
 * confirms payer identity (EIN + address, which have no schema home yet), reviews
 * the assembled batch — ready records, total comp, and the FIX-FIRST blockers
 * (missing TIN / W-9) — then downloads the filing-service e-file (CSV), the branded
 * recipient Copy B PDFs, and can read the summary. A blocked contractor is excluded
 * from the file by construction, so the operator can't accidentally file a bad TIN.
 */

interface GenSummary {
  taxYear: number;
  thresholdCents: number;
  readyCount: number;
  totalNonemployeeCompCents: number;
  blockedCount: number;
  blockedDollarsCents: number;
  excludedCount: number;
  payerTinMissing: boolean;
}

interface GenRecord {
  vendorId: string;
  recipientName: string;
  recipientTinMasked: string;
  box1NonemployeeCompCents: number;
  hasAddress: boolean;
}

interface GenExclusion {
  vendorId: string;
  vendorName: string;
  totalPaidCents: number;
  status: 'BLOCKED' | 'EXCLUDED';
  code: string;
  reason: string;
  fixFirst: boolean;
}

interface GenResponse {
  payer: { name: string; tinMasked: string | null };
  summary: GenSummary;
  records: GenRecord[];
  exclusions: GenExclusion[];
}

/** IRS FIRE e-file readiness (from /api/tax/1099/efile?format=summary). */
interface FireInfo {
  readyCount: number;
  hasPlaceholders: boolean;
  warnings: string[];
  recordCount: number;
  payeeCount: number;
}

interface PayerForm {
  payerName: string;
  payerTin: string;
  payerAddress1: string;
  payerAddress2: string;
  payerCity: string;
  payerState: string;
  payerZip: string;
  payerPhone: string;
}

const EMPTY_PAYER: PayerForm = {
  payerName: '',
  payerTin: '',
  payerAddress1: '',
  payerAddress2: '',
  payerCity: '',
  payerState: '',
  payerZip: '',
  payerPhone: '',
};

function queryParams(year: number, payer: PayerForm): Record<string, string> {
  const p: Record<string, string> = { year: String(year) };
  (Object.keys(payer) as (keyof PayerForm)[]).forEach((k) => {
    const v = payer[k].trim();
    if (v) p[k] = v;
  });
  return p;
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  className,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  className?: string;
}) {
  return (
    <label className={clsx('block', className)}>
      <span className="mb-1 block text-[11px] uppercase tracking-wide text-slate-500">{label}</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full rounded-lg border border-slate-800 bg-slate-950 px-3 py-1.5 text-sm text-white placeholder:text-slate-600 focus:border-emerald-500/50 focus:outline-none"
      />
    </label>
  );
}

export function Generate1099Modal({ year, onClose }: { year: number; onClose: () => void }) {
  const [payer, setPayer] = useState<PayerForm>(EMPTY_PAYER);
  const [data, setData] = useState<GenResponse | null>(null);
  const [fire, setFire] = useState<FireInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = (k: keyof PayerForm) => (v: string) => setPayer((p) => ({ ...p, [k]: v }));

  const review = useCallback(async () => {
    setLoading(true);
    setError(null);
    // Assemble the batch (records + exclusions) and, in parallel, the FIRE e-file
    // readiness (config warnings: TCC / transmitter TIN placeholders).
    const [res, fireRes] = await Promise.all([
      api.get<GenResponse>('/api/compliance/1099/generate', {
        ...queryParams(year, payer),
        format: 'summary',
      }),
      api.get<FireInfo>('/api/tax/1099/efile', {
        ...queryParams(year, payer),
        format: 'summary',
      }),
    ]);
    setLoading(false);
    if (res.error) {
      setError(res.error.error || 'Could not assemble 1099 batch');
      return;
    }
    setData(res.data ?? null);
    setFire(fireRes.error ? null : fireRes.data ?? null);
  }, [year, payer]);

  // Initial review on open so the operator immediately sees the population.
  useEffect(() => {
    void review();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function download(format: 'csv' | 'pdf') {
    if (!data || data.summary.readyCount === 0) {
      addToast('error', 'No filable records — resolve blockers first');
      return;
    }
    if (data.summary.payerTinMissing) {
      addToast('error', 'Enter the payer EIN before downloading the e-file');
      return;
    }
    const qs = new URLSearchParams({ ...queryParams(year, payer), format }).toString();
    window.open(`/api/compliance/1099/generate?${qs}`, '_blank');
    addToast('success', format === 'csv' ? 'E-file downloading' : 'Recipient copies downloading');
  }

  function downloadFire() {
    if (!data || data.summary.readyCount === 0) {
      addToast('error', 'No filable records — resolve blockers first');
      return;
    }
    if (data.summary.payerTinMissing) {
      addToast('error', 'Enter the payer EIN before downloading the IRS e-file');
      return;
    }
    const qs = new URLSearchParams({ ...queryParams(year, payer), format: 'fire' }).toString();
    window.open(`/api/tax/1099/efile?${qs}`, '_blank');
    addToast(
      fire?.hasPlaceholders ? 'error' : 'success',
      fire?.hasPlaceholders
        ? 'IRS FIRE file downloading — NOT transmittable until TCC / TIN gaps are cleared'
        : 'IRS FIRE file downloading',
    );
  }

  const summary = data?.summary;
  const blocked = (data?.exclusions ?? []).filter((e) => e.status === 'BLOCKED');
  const excluded = (data?.exclusions ?? []).filter((e) => e.status === 'EXCLUDED');

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4 backdrop-blur-sm">
      <div className="my-6 w-full max-w-3xl rounded-xl border border-slate-800 bg-slate-900 shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-800 px-5 py-4">
          <div>
            <h2 className="text-base font-semibold text-white">Generate {year} 1099-NEC</h2>
            <p className="mt-0.5 text-xs text-slate-500">
              Read-only assembly off the ledger — review, fix blockers, then download. Nothing is filed
              with the IRS.
            </p>
          </div>
          <button onClick={onClose} className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-800 hover:text-slate-300">
            <X size={18} />
          </button>
        </div>

        <div className="max-h-[70vh] space-y-5 overflow-y-auto px-5 py-5">
          {/* Payer identity */}
          <section>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">Payer (filer)</h3>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              <Field label="Payer name" value={payer.payerName} onChange={set('payerName')} placeholder="(defaults to org)" className="col-span-2 sm:col-span-2" />
              <Field label="Payer EIN *" value={payer.payerTin} onChange={set('payerTin')} placeholder="12-3456789" />
              <Field label="Address" value={payer.payerAddress1} onChange={set('payerAddress1')} placeholder="(defaults to remit-to)" className="col-span-2" />
              <Field label="Suite / line 2" value={payer.payerAddress2} onChange={set('payerAddress2')} />
              <Field label="City" value={payer.payerCity} onChange={set('payerCity')} />
              <Field label="State" value={payer.payerState} onChange={set('payerState')} placeholder="IA" />
              <Field label="ZIP" value={payer.payerZip} onChange={set('payerZip')} />
              <Field label="Phone" value={payer.payerPhone} onChange={set('payerPhone')} />
            </div>
            <button
              onClick={() => void review()}
              disabled={loading}
              className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800/50 px-3 py-1.5 text-xs font-medium text-slate-200 hover:border-emerald-500/40 hover:text-emerald-400 disabled:opacity-60"
            >
              {loading ? <Loader2 size={13} className="animate-spin" /> : <Wrench size={13} />} Re-assemble
            </button>
          </section>

          {/* States */}
          {loading && !data ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin text-emerald-400" />
            </div>
          ) : error ? (
            <div className="rounded-lg border border-red-500/20 bg-red-500/5 p-4 text-sm text-red-400">
              <AlertCircle className="mb-1 inline h-4 w-4" /> {error}
            </div>
          ) : summary ? (
            <>
              {/* Filing summary tiles */}
              <div className="grid grid-cols-3 gap-3">
                <div className="rounded-lg border border-slate-800 bg-slate-950 p-3">
                  <div className="flex items-center gap-1.5 text-[11px] text-slate-500"><Users size={12} /> Ready to file</div>
                  <p className="mt-1 font-mono text-xl font-semibold text-emerald-400">{summary.readyCount}</p>
                </div>
                <div className="rounded-lg border border-slate-800 bg-slate-950 p-3">
                  <div className="flex items-center gap-1.5 text-[11px] text-slate-500"><DollarSign size={12} /> Total comp (Box 1)</div>
                  <p className="mt-1 font-mono text-xl font-semibold text-white">{formatMoney(summary.totalNonemployeeCompCents)}</p>
                </div>
                <div className="rounded-lg border border-slate-800 bg-slate-950 p-3">
                  <div className="flex items-center gap-1.5 text-[11px] text-slate-500"><ShieldAlert size={12} /> Blockers</div>
                  <p className={clsx('mt-1 font-mono text-xl font-semibold', summary.blockedCount > 0 ? 'text-red-400' : 'text-slate-500')}>{summary.blockedCount}</p>
                </div>
              </div>

              {summary.payerTinMissing && (
                <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-xs text-amber-400">
                  Enter the payer EIN above — it's required on every 1099 and blocks the e-file until set.
                </div>
              )}

              {/* IRS FIRE e-file readiness — config gaps (TCC / transmitter TIN) */}
              {fire && (fire.hasPlaceholders || fire.warnings.length > 0) && (
                <section className="rounded-lg border border-indigo-500/20 bg-indigo-500/5 px-3 py-2.5">
                  <h3 className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-indigo-300">
                    <Landmark size={13} /> IRS FIRE e-file{' '}
                    {fire.hasPlaceholders ? (
                      <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-400">
                        config incomplete
                      </span>
                    ) : (
                      <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-medium text-emerald-400">
                        ready
                      </span>
                    )}
                  </h3>
                  <ul className="space-y-1 text-[11px] leading-relaxed text-slate-400">
                    {fire.warnings.map((w, i) => (
                      <li key={i} className="flex gap-1.5">
                        <span className="mt-0.5 text-indigo-400">•</span>
                        <span>{w}</span>
                      </li>
                    ))}
                  </ul>
                  <p className="mt-1.5 text-[10px] text-slate-600">
                    Nothing is transmitted — this produces a file you upload to the IRS FIRE system yourself.
                  </p>
                </section>
              )}

              {/* Fix-first blockers */}
              {blocked.length > 0 && (
                <section>
                  <h3 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-red-400">
                    <Wrench size={13} /> Fix first — {formatMoney(summary.blockedDollarsCents)} blocked
                  </h3>
                  <ul className="space-y-1.5">
                    {blocked.map((e) => (
                      <li key={e.vendorId} className="rounded-lg border border-red-500/15 bg-red-500/[0.03] px-3 py-2">
                        <div className="flex items-center justify-between">
                          <span className="text-sm font-medium text-white">{e.vendorName}</span>
                          <span className="font-mono text-xs text-slate-400">{formatMoney(e.totalPaidCents)}</span>
                        </div>
                        <p className="mt-0.5 text-[11px] leading-relaxed text-slate-500">{e.reason}</p>
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {/* Ready records */}
              {data && data.records.length > 0 ? (
                <section>
                  <h3 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-emerald-400">
                    <CheckCircle2 size={13} /> Ready ({data.records.length})
                  </h3>
                  <div className="overflow-hidden rounded-lg border border-slate-800">
                    <table className="w-full text-sm">
                      <tbody className="divide-y divide-slate-800/60">
                        {data.records.map((r) => (
                          <tr key={r.vendorId}>
                            <td className="px-3 py-2 text-white">{r.recipientName}</td>
                            <td className="px-3 py-2 font-mono text-xs text-slate-500">{r.recipientTinMasked}</td>
                            <td className="px-3 py-2 text-right">
                              {r.hasAddress ? (
                                <span className="text-[11px] text-slate-600">addr ok</span>
                              ) : (
                                <span className="text-[11px] text-amber-400">no address</span>
                              )}
                            </td>
                            <td className="px-3 py-2 text-right font-mono text-slate-200">{formatMoney(r.box1NonemployeeCompCents)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>
              ) : (
                <div className="rounded-lg border border-slate-800 bg-slate-950 p-6 text-center text-sm text-slate-500">
                  No filable records yet. Mark candidates 1099-eligible and collect their W-9 / TIN, then re-assemble.
                </div>
              )}

              {excluded.length > 0 && (
                <p className="text-[11px] text-slate-600">
                  {excluded.length} candidate{excluded.length === 1 ? '' : 's'} excluded (below $600 or not marked
                  1099-eligible — likely a corporation / exempt payee).
                </p>
              )}
            </>
          ) : null}
        </div>

        {/* Footer actions */}
        <div className="flex items-center justify-end gap-2 border-t border-slate-800 px-5 py-3">
          <button onClick={onClose} className="rounded-lg px-3 py-1.5 text-xs font-medium text-slate-400 hover:text-white">
            Close
          </button>
          <button
            onClick={() => download('pdf')}
            disabled={!summary || summary.readyCount === 0}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800/50 px-3 py-1.5 text-xs font-medium text-slate-200 hover:border-emerald-500/40 hover:text-emerald-400 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <FileText size={14} /> Recipient copies (PDF)
          </button>
          <button
            onClick={() => download('csv')}
            disabled={!summary || summary.readyCount === 0 || summary.payerTinMissing}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800/50 px-3 py-1.5 text-xs font-medium text-slate-200 hover:border-emerald-500/40 hover:text-emerald-400 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <FileSpreadsheet size={14} /> Filing-service CSV
          </button>
          <button
            onClick={downloadFire}
            disabled={!summary || summary.readyCount === 0 || summary.payerTinMissing}
            title="IRS FIRE fixed-width e-file (Pub. 1220). File only — you upload it to FIRE yourself."
            className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-500 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <FileCode2 size={14} /> IRS e-file (FIRE)
          </button>
        </div>
      </div>
    </div>
  );
}
