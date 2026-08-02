'use client';

import { useCallback, useState } from 'react';
import { clsx } from 'clsx';
import { formatMoney, dollarsToCents } from '@meritbooks/shared';
import { api } from '@/lib/api-client';
import { addToast } from '@/hooks/use-toast';
import { Loader2, X, ArrowRight, AlertCircle } from 'lucide-react';

/**
 * Preview-then-confirm modal for the three ASC 842 post-commencement events:
 *   - modify   — remeasure for a revised payment / term / rate,
 *   - cpi      — apply an index/CPI payment reset (original rate + term hold),
 *   - terminate — early termination (write off ROU + liability, book gain/loss).
 *
 * A human always sees the remeasured ROU + liability and the resulting balanced entry
 * BEFORE anything posts; confirming posts through the deterministic engine and rebuilds
 * the forward schedule (already-posted periods untouched).
 */

export type RemeasureMode = 'modify' | 'cpi' | 'terminate';

interface LeaseLite {
  id: string;
  lessor: string;
  classification: 'OPERATING' | 'FINANCE';
  payment_cents: number;
  payment_frequency: 'MONTHLY' | 'QUARTERLY' | 'ANNUAL';
  discount_rate: number | string;
  rou_asset_cents: number;
  liability_cents: number;
}

interface Leg { role: string; debitCents: number; creditCents: number; memo: string }

interface RemeasurePreview {
  effectivePeriod: number;
  effectiveDate: string;
  before: { liabilityCents: number; rouCents: number; remainingPeriods: number };
  after: { liabilityCents: number; rouCents: number; remainingPeriods: number };
  result: { treatment: string; gainLossCents: number; legs: Leg[] };
}

interface TerminationPreview {
  effectivePeriod: number;
  effectiveDate: string;
  result: { writeoffLiabilityCents: number; writeoffRouCents: number; penaltyCents: number; gainLossCents: number; legs: Leg[] };
}

const ROLE_LABEL: Record<string, string> = {
  ROU_ASSET: 'Right-of-Use Asset',
  LEASE_LIABILITY: 'Lease Liability',
  GAIN_ON_DISPOSAL: 'Gain (lease)',
  LOSS_ON_DISPOSAL: 'Loss (lease)',
  OPERATING_BANK: 'Cash / Operating Bank',
};

const TITLES: Record<RemeasureMode, string> = {
  modify: 'Modify lease',
  cpi: 'Apply CPI / rate reset',
  terminate: 'Terminate lease',
};

function periodsFor(lease: LeaseLite): number {
  const per = lease.payment_frequency === 'MONTHLY' ? 1 : lease.payment_frequency === 'QUARTERLY' ? 3 : 12;
  return per; // months per period (used only to hint the user on the "remaining periods" field)
}

export function LeaseRemeasureModal({
  lease,
  mode,
  onClose,
  onDone,
}: {
  lease: LeaseLite;
  mode: RemeasureMode;
  onClose: () => void;
  onDone: () => void;
}) {
  const [payment, setPayment] = useState<string>((Number(lease.payment_cents) / 100).toFixed(2));
  const [remainingPeriods, setRemainingPeriods] = useState<string>('');
  const [rate, setRate] = useState<string>((Number(lease.discount_rate) * 100).toFixed(3));
  const [scopeReduction, setScopeReduction] = useState(false);
  const [penalty, setPenalty] = useState<string>('0.00');

  const [preview, setPreview] = useState<RemeasurePreview | null>(null);
  const [termPreview, setTermPreview] = useState<TerminationPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const endpoint = `/api/leases/${lease.id}/${mode}`;

  const buildBody = useCallback(
    (confirm: boolean) => {
      if (mode === 'terminate') return { confirm, penalty_cents: dollarsToCents(Number(penalty || '0')) };
      if (mode === 'cpi') return { confirm, payment_cents: dollarsToCents(Number(payment || '0')) };
      return {
        confirm,
        payment_cents: dollarsToCents(Number(payment || '0')),
        remaining_periods: Number(remainingPeriods || '0'),
        discount_rate: Number(rate || '0') / 100,
        scope_reduction: scopeReduction || undefined,
      };
    },
    [mode, payment, remainingPeriods, rate, scopeReduction, penalty],
  );

  async function runPreview() {
    setError(null);
    setBusy(true);
    const res = await api.post<{ data: RemeasurePreview | TerminationPreview }>(endpoint, buildBody(false));
    setBusy(false);
    if (res.error) { setError(res.error.error || 'Preview failed.'); return; }
    if (mode === 'terminate') { setTermPreview(res.data!.data as TerminationPreview); setPreview(null); }
    else { setPreview(res.data!.data as RemeasurePreview); setTermPreview(null); }
  }

  async function confirm() {
    setError(null);
    setBusy(true);
    const res = await api.post<{ data: { message: string } }>(endpoint, buildBody(true));
    setBusy(false);
    if (res.error) { setError(res.error.error || 'Could not apply the change.'); return; }
    addToast('success', res.data?.data?.message ?? 'Applied.');
    onDone();
  }

  const legs = (preview?.result.legs ?? termPreview?.result.legs ?? []) as Leg[];
  const gainLoss = preview?.result.gainLossCents ?? termPreview?.result.gainLossCents ?? 0;
  const hasPreview = preview !== null || termPreview !== null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true">
      <div className="w-full max-w-xl card p-6 max-h-[90vh] overflow-y-auto">
        <div className="flex items-start justify-between mb-4">
          <div>
            <h2 className="text-base font-semibold text-white">{TITLES[mode]}</h2>
            <p className="text-[12px] text-slate-500 mt-0.5">{lease.lessor} — {lease.classification === 'OPERATING' ? 'operating' : 'finance'} lease</p>
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-white" aria-label="Close"><X size={18} /></button>
        </div>

        {/* ── Inputs ─────────────────────────────────────────────── */}
        <div className="space-y-3">
          {mode !== 'terminate' && (
            <label className="block">
              <span className="text-[11px] text-slate-400">{mode === 'cpi' ? 'New index-based payment ($)' : 'Revised payment ($)'}</span>
              <input value={payment} onChange={(e) => setPayment(e.target.value)} inputMode="decimal"
                className="mt-1 w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white font-mono focus:border-emerald-500 outline-none" />
            </label>
          )}
          {mode === 'modify' && (
            <>
              <div className="grid grid-cols-2 gap-3">
                <label className="block">
                  <span className="text-[11px] text-slate-400">Revised remaining periods</span>
                  <input value={remainingPeriods} onChange={(e) => setRemainingPeriods(e.target.value)} inputMode="numeric" placeholder="e.g. 24"
                    className="mt-1 w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white font-mono focus:border-emerald-500 outline-none" />
                  <span className="text-[10px] text-slate-600">{periodsFor(lease)} month(s) per period</span>
                </label>
                <label className="block">
                  <span className="text-[11px] text-slate-400">Revised rate (%)</span>
                  <input value={rate} onChange={(e) => setRate(e.target.value)} inputMode="decimal"
                    className="mt-1 w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white font-mono focus:border-emerald-500 outline-none" />
                </label>
              </div>
              <label className="flex items-center gap-2 text-[12px] text-slate-300">
                <input type="checkbox" checked={scopeReduction} onChange={(e) => setScopeReduction(e.target.checked)} className="accent-emerald-500" />
                Treat as a reduction in scope (partial termination — recognizes a gain/loss)
              </label>
            </>
          )}
          {mode === 'terminate' && (
            <label className="block">
              <span className="text-[11px] text-slate-400">Termination penalty paid ($)</span>
              <input value={penalty} onChange={(e) => setPenalty(e.target.value)} inputMode="decimal"
                className="mt-1 w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white font-mono focus:border-emerald-500 outline-none" />
            </label>
          )}
        </div>

        <button onClick={runPreview} disabled={busy}
          className="mt-4 px-3 py-1.5 text-xs font-medium bg-slate-700 hover:bg-slate-600 text-white rounded-lg disabled:opacity-40 inline-flex items-center gap-1.5">
          {busy && !hasPreview ? <Loader2 size={13} className="animate-spin" /> : null} Preview
        </button>

        {error && (
          <div className="mt-3 flex items-start gap-2 text-[12px] text-red-300 bg-red-500/10 border border-red-500/20 rounded-lg p-2.5">
            <AlertCircle size={14} className="mt-0.5" /> {error}
          </div>
        )}

        {/* ── Before / after ─────────────────────────────────────── */}
        {preview && (
          <div className="mt-4 grid grid-cols-2 gap-3">
            <BeforeAfter label="Lease liability" before={preview.before.liabilityCents} after={preview.after.liabilityCents} />
            <BeforeAfter label="ROU asset" before={preview.before.rouCents} after={preview.after.rouCents} />
            <div className="col-span-2 text-[11px] text-slate-500">
              Effective period {preview.effectivePeriod} ({preview.effectiveDate}) · treatment: <span className="text-slate-300">{preview.result.treatment === 'SCOPE_REDUCTION' ? 'partial termination' : 'remeasurement'}</span> · remaining periods {preview.before.remainingPeriods} <ArrowRight size={10} className="inline" /> {preview.after.remainingPeriods}
            </div>
          </div>
        )}
        {termPreview && (
          <div className="mt-4 grid grid-cols-2 gap-3">
            <Stat label="Liability written off" value={formatMoney(termPreview.result.writeoffLiabilityCents)} />
            <Stat label="ROU written off" value={formatMoney(termPreview.result.writeoffRouCents)} />
            <div className="col-span-2 text-[11px] text-slate-500">Effective period {termPreview.effectivePeriod} ({termPreview.effectiveDate})</div>
          </div>
        )}

        {/* ── Proposed entry ─────────────────────────────────────── */}
        {hasPreview && (
          <div className="mt-4">
            <p className="text-[11px] text-slate-500 mb-1">Proposed journal entry</p>
            {legs.length === 0 ? (
              <p className="text-[12px] text-slate-400">No adjusting entry required — only the forward schedule is rebuilt.</p>
            ) : (
              <table className="w-full text-[11px] font-mono">
                <thead>
                  <tr className="text-slate-500 text-left border-b border-slate-800">
                    <th className="py-1 pr-3 font-medium">Account</th>
                    <th className="py-1 pr-3 font-medium text-right">Debit</th>
                    <th className="py-1 pr-3 font-medium text-right">Credit</th>
                  </tr>
                </thead>
                <tbody>
                  {legs.map((l, i) => (
                    <tr key={i} className="border-b border-slate-900">
                      <td className="py-1 pr-3 text-slate-300">{ROLE_LABEL[l.role] ?? l.role}</td>
                      <td className="py-1 pr-3 text-right text-emerald-400">{l.debitCents ? formatMoney(l.debitCents) : ''}</td>
                      <td className="py-1 pr-3 text-right text-red-400">{l.creditCents ? formatMoney(l.creditCents) : ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {gainLoss !== 0 && (
              <p className={clsx('text-[11px] mt-1.5', gainLoss > 0 ? 'text-emerald-400' : 'text-red-400')}>
                {gainLoss > 0 ? 'Gain' : 'Loss'} recognized: {formatMoney(Math.abs(gainLoss))}
              </p>
            )}
          </div>
        )}

        {/* ── Actions ────────────────────────────────────────────── */}
        <div className="mt-6 flex items-center justify-end gap-2">
          <button onClick={onClose} className="px-3 py-1.5 text-xs text-slate-400 hover:text-white">Cancel</button>
          <button onClick={confirm} disabled={busy || !hasPreview}
            className={clsx('px-4 py-1.5 text-xs font-medium text-white rounded-lg disabled:opacity-40 inline-flex items-center gap-1.5',
              mode === 'terminate' ? 'bg-amber-600 hover:bg-amber-500' : 'bg-emerald-600 hover:bg-emerald-500')}>
            {busy && hasPreview ? <Loader2 size={13} className="animate-spin" /> : null}
            {mode === 'terminate' ? 'Confirm termination' : 'Confirm & post'}
          </button>
        </div>
      </div>
    </div>
  );
}

function BeforeAfter({ label, before, after }: { label: string; before: number; after: number }) {
  const delta = after - before;
  return (
    <div className="card p-3 bg-slate-950/40">
      <p className="text-[10px] text-slate-500">{label}</p>
      <div className="flex items-center gap-1.5 mt-0.5 font-mono text-xs">
        <span className="text-slate-400">{formatMoney(before)}</span>
        <ArrowRight size={11} className="text-slate-600" />
        <span className="text-white">{formatMoney(after)}</span>
      </div>
      {delta !== 0 && <p className={clsx('text-[10px] mt-0.5 font-mono', delta > 0 ? 'text-emerald-400' : 'text-red-400')}>{delta > 0 ? '+' : ''}{formatMoney(delta)}</p>}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="card p-3 bg-slate-950/40">
      <p className="text-[10px] text-slate-500">{label}</p>
      <p className="text-xs text-white font-mono mt-0.5">{value}</p>
    </div>
  );
}
