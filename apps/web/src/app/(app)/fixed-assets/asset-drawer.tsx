'use client';

import { useState } from 'react';
import { formatMoney, dollarsToCents } from '@meritbooks/shared';
import { Loader2, TrendingUp, TrendingDown, Minus, Archive } from 'lucide-react';
import { clsx } from 'clsx';
import { StatusBadge } from '@/components/ui';
import { DetailDrawer, DetailSection, DetailField } from '@/components/detail-drawer';
import { addToast } from '@/hooks';
import { api } from '@/lib/api-client';

export interface AssetLike {
  id: string; name: string; assetTag: string | null; serialNumber: string | null; category: string | null;
  acquisitionDate: string; acquisitionCostCents: number; salvageValueCents: number; usefulLifeMonths: number;
  depreciationMethod: string; accumulatedDepreciationCents: number; netBookValueCents: number;
  lastDepreciationDate: string | null; status: string; physicalLocation: string | null; condition: string | null;
  totalExpectedUnits: number | null; unitsUsed: number;
  location: { id: string; name: string; short_code: string } | null;
  assignedTo: { id: string; first_name: string; last_name: string } | null;
}

// Book methods post to the GL (straight-line, 200%/150% declining balance,
// sum-of-years-digits, units-of-production); MACRS_* drive the parallel TAX track.
const METHOD_OPTIONS: { value: string; label: string; book: boolean }[] = [
  { value: 'STRAIGHT_LINE', label: 'Straight-line', book: true },
  { value: 'DOUBLE_DECLINING', label: 'Double-declining (200% DB)', book: true },
  { value: 'DECLINING_150', label: '150% declining balance', book: true },
  { value: 'SUM_OF_YEARS_DIGITS', label: 'Sum-of-years-digits', book: true },
  { value: 'UNITS_OF_PRODUCTION', label: 'Units of production', book: true },
  { value: 'MACRS_5', label: 'MACRS 5-yr (tax)', book: false },
  { value: 'MACRS_7', label: 'MACRS 7-yr (tax)', book: false },
];

interface SchedulePeriod { index: number; period: string; amountCents: number; cumulativeCents: number }
interface DisposalLine { role: string; accountId: string; debitCents: number; creditCents: number; memo: string }
interface DisposalPreview {
  net_book_value_cents: number; gain_loss_cents: number; outcome: 'GAIN' | 'LOSS' | 'BREAKEVEN'; lines: DisposalLine[];
}

export function AssetDrawer({ asset, onClose, onChanged }: { asset: AssetLike | null; onClose: () => void; onChanged?: () => void }) {
  const [method, setMethod] = useState<string>('');
  const [savingMethod, setSavingMethod] = useState(false);
  const [totalUnits, setTotalUnits] = useState('');
  const [unitsUsedInput, setUnitsUsedInput] = useState('');
  const [savingUnits, setSavingUnits] = useState(false);
  const [schedule, setSchedule] = useState<SchedulePeriod[] | null>(null);
  const [scheduleLoading, setScheduleLoading] = useState(false);
  const [scheduleErr, setScheduleErr] = useState<string | null>(null);

  const [disposing, setDisposing] = useState(false);
  const [disposalDate, setDisposalDate] = useState(new Date().toISOString().slice(0, 10));
  const [proceeds, setProceeds] = useState('');
  const [rail, setRail] = useState('ach');
  const [preview, setPreview] = useState<DisposalPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [disposalErr, setDisposalErr] = useState<string | null>(null);

  if (!asset) return <DetailDrawer open={false} onClose={onClose} width="md" title="Asset" />;

  const started = asset.accumulatedDepreciationCents > 0;
  const disposed = asset.status === 'DISPOSED';
  const currentMethod = method || asset.depreciationMethod;
  const depPct = asset.acquisitionCostCents > 0
    ? Math.round((asset.accumulatedDepreciationCents / asset.acquisitionCostCents) * 100) : 0;

  const loadSchedule = async (m: string) => {
    setScheduleLoading(true); setScheduleErr(null); setSchedule(null);
    const res = await api.get<{ periods: SchedulePeriod[] }>('/api/fixed-assets/schedule', { assetId: asset.id, method: m });
    if (res.error) setScheduleErr(res.error.error);
    else setSchedule(res.data?.periods ?? []);
    setScheduleLoading(false);
  };

  const saveMethod = async () => {
    setSavingMethod(true);
    const res = await api.patch<{ ok: boolean }>('/api/fixed-assets', { id: asset.id, depreciationMethod: currentMethod });
    setSavingMethod(false);
    if (res.error) { addToast('error', res.error.error); return; }
    addToast('success', 'Depreciation method updated');
    onChanged?.();
    onClose();
  };

  const saveUnits = async () => {
    const patch: Record<string, unknown> = {};
    if (!started && totalUnits.trim() !== '') {
      const t = Number(totalUnits);
      if (!Number.isFinite(t) || t <= 0) { addToast('error', 'Total expected units must be a positive number'); return; }
      patch.totalExpectedUnits = t;
    }
    if (unitsUsedInput.trim() !== '') {
      const u = Number(unitsUsedInput);
      if (!Number.isFinite(u) || u < 0) { addToast('error', 'Units used must be a non-negative number'); return; }
      patch.unitsUsed = u;
    }
    if (Object.keys(patch).length === 0) { addToast('error', 'Enter a value to save'); return; }
    setSavingUnits(true);
    const res = await api.patch<{ ok: boolean }>('/api/fixed-assets', { id: asset.id, ...patch });
    setSavingUnits(false);
    if (res.error) { addToast('error', res.error.error); return; }
    addToast('success', 'Units updated');
    setTotalUnits(''); setUnitsUsedInput('');
    onChanged?.();
    onClose();
  };

  const runPreview = async () => {
    setBusy(true); setDisposalErr(null); setPreview(null);
    const cents = proceeds.trim() === '' ? 0 : dollarsToCents(proceeds);
    const res = await api.post<DisposalPreview>('/api/fixed-assets/dispose', {
      assetId: asset.id, disposalDate, proceedsCents: cents, rail, preview: true,
    });
    setBusy(false);
    if (res.error) { setDisposalErr(res.error.error); return; }
    setPreview(res.data);
  };

  const confirmDisposal = async () => {
    setBusy(true); setDisposalErr(null);
    const cents = proceeds.trim() === '' ? 0 : dollarsToCents(proceeds);
    const res = await api.post<{ gain_loss_cents: number }>('/api/fixed-assets/dispose', {
      assetId: asset.id, disposalDate, proceedsCents: cents, rail, preview: false,
    });
    setBusy(false);
    if (res.error) { setDisposalErr(res.error.error); return; }
    addToast('success', 'Asset disposed and posted to the GL');
    onChanged?.();
    onClose();
  };

  return (
    <DetailDrawer
      open={!!asset} onClose={onClose} width="md"
      title={asset.name}
      subtitle={[asset.assetTag, asset.category].filter(Boolean).join(' · ') || null}
      headerRight={<StatusBadge status={asset.status} />}
    >
      <DetailSection title="Asset">
        <DetailField label="Tag" value={asset.assetTag ?? '--'} />
        <DetailField label="Serial" value={asset.serialNumber ?? '--'} />
        <DetailField label="Category" value={asset.category ?? '--'} />
        <DetailField label="Company" value={asset.location?.name ?? '--'} />
        {asset.physicalLocation && <DetailField label="Physical location" value={asset.physicalLocation} />}
        {asset.assignedTo && <DetailField label="Assigned to" value={`${asset.assignedTo.first_name} ${asset.assignedTo.last_name}`} />}
        {asset.condition && <DetailField label="Condition" value={asset.condition} />}
      </DetailSection>

      <DetailSection title="Depreciation">
        <DetailField label="Acquired" value={asset.acquisitionDate} mono />
        <DetailField label="Cost" value={formatMoney(asset.acquisitionCostCents)} mono />
        <DetailField label="Salvage value" value={formatMoney(asset.salvageValueCents)} mono />
        <DetailField label="Useful life" value={`${asset.usefulLifeMonths} months`} />
        <DetailField label="Accumulated" value={`${formatMoney(asset.accumulatedDepreciationCents)} (${depPct}%)`} mono />
        <DetailField label="Net book value" value={formatMoney(asset.netBookValueCents)} mono />
        <DetailField label="Last depreciation" value={asset.lastDepreciationDate ?? '--'} mono />
      </DetailSection>

      {/* Method selection + schedule preview */}
      {!disposed && (
        <DetailSection title="Method">
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <select
                value={currentMethod}
                disabled={started}
                onChange={(e) => { setMethod(e.target.value); setSchedule(null); }}
                className="flex-1 px-3 py-1.5 bg-slate-800 border border-slate-700 rounded-lg text-xs text-white disabled:opacity-50"
              >
                {METHOD_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}{o.book ? '' : ' — parallel tax book'}</option>)}
              </select>
              <button
                onClick={saveMethod}
                disabled={started || savingMethod || currentMethod === asset.depreciationMethod}
                className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed rounded-lg text-xs font-medium text-white"
              >
                {savingMethod ? <Loader2 size={13} className="animate-spin" /> : 'Save'}
              </button>
            </div>
            {started && <p className="text-2xs text-amber-400">Basis is locked — depreciation has already begun.</p>}

            {currentMethod === 'UNITS_OF_PRODUCTION' && (
              <div className="rounded-md bg-slate-800/40 p-3 space-y-2">
                <p className="text-2xs uppercase text-slate-500">Units of production</p>
                <div className="flex items-center justify-between text-2xs">
                  <span className="text-slate-500">Total expected</span>
                  <span className="font-mono text-slate-300">{asset.totalExpectedUnits ?? '--'}</span>
                </div>
                <div className="flex items-center justify-between text-2xs">
                  <span className="text-slate-500">Used to date</span>
                  <span className="font-mono text-slate-300">{asset.unitsUsed}</span>
                </div>
                {!started && (
                  <div>
                    <label className="block text-2xs text-slate-500 mb-1">Set total expected units</label>
                    <input type="number" min="0" step="any" value={totalUnits} placeholder={asset.totalExpectedUnits != null ? String(asset.totalExpectedUnits) : 'e.g. 100000'}
                      onChange={(e) => setTotalUnits(e.target.value)}
                      className="w-full px-2 py-1.5 bg-slate-800 border border-slate-700 rounded-lg text-xs text-white font-mono" />
                  </div>
                )}
                <div>
                  <label className="block text-2xs text-slate-500 mb-1">Record units used to date (cumulative)</label>
                  <input type="number" min="0" step="any" value={unitsUsedInput} placeholder={String(asset.unitsUsed)}
                    onChange={(e) => setUnitsUsedInput(e.target.value)}
                    className="w-full px-2 py-1.5 bg-slate-800 border border-slate-700 rounded-lg text-xs text-white font-mono" />
                </div>
                <button onClick={saveUnits} disabled={savingUnits}
                  className="w-full px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 rounded-lg text-xs font-medium text-white flex items-center justify-center">
                  {savingUnits ? <Loader2 size={13} className="animate-spin" /> : 'Save units'}
                </button>
                <p className="text-2xs text-slate-600">The next depreciation run charges the incremental usage since the last run.</p>
              </div>
            )}

            <button onClick={() => loadSchedule(currentMethod)} className="text-2xs text-indigo-400 hover:text-indigo-300">
              Preview projected schedule
            </button>
            {scheduleLoading && <div className="py-2"><Loader2 size={14} className="animate-spin text-emerald-400" /></div>}
            {scheduleErr && <p className="text-2xs text-red-400">{scheduleErr}</p>}
            {schedule && schedule.length > 0 && (
              <div className="rounded-md bg-slate-800/40 max-h-48 overflow-y-auto">
                <table className="w-full text-2xs">
                  <thead className="sticky top-0 bg-slate-900/80">
                    <tr className="text-slate-500">
                      <th className="px-2 py-1 text-left font-medium">Period</th>
                      <th className="px-2 py-1 text-right font-medium">Depreciation</th>
                      <th className="px-2 py-1 text-right font-medium">Cumulative</th>
                    </tr>
                  </thead>
                  <tbody>
                    {schedule.slice(0, 24).map((p) => (
                      <tr key={p.index} className="border-t border-slate-800/40">
                        <td className="px-2 py-1 font-mono text-slate-400">{p.period}</td>
                        <td className="px-2 py-1 text-right font-mono text-amber-400">{formatMoney(p.amountCents)}</td>
                        <td className="px-2 py-1 text-right font-mono text-slate-300">{formatMoney(p.cumulativeCents)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {schedule.length > 24 && <p className="px-2 py-1 text-2xs text-slate-600">+{schedule.length - 24} more periods…</p>}
              </div>
            )}
          </div>
        </DetailSection>
      )}

      {/* Disposal */}
      {disposed ? (
        <DetailSection title="Disposal">
          <p className="text-2xs text-slate-500">This asset has been disposed.</p>
        </DetailSection>
      ) : (
        <DetailSection title="Disposal">
          {!disposing ? (
            <button
              onClick={() => setDisposing(true)}
              className="w-full flex items-center justify-center gap-2 px-3 py-2 border border-slate-700 hover:border-red-500/50 hover:bg-red-500/5 rounded-lg text-xs text-slate-300"
            >
              <Archive size={14} /> Dispose / retire asset
            </button>
          ) : (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-2xs uppercase text-slate-500 mb-1">Disposal date</label>
                  <input type="date" value={disposalDate} onChange={(e) => { setDisposalDate(e.target.value); setPreview(null); }}
                    className="w-full px-2 py-1.5 bg-slate-800 border border-slate-700 rounded-lg text-xs text-white" />
                </div>
                <div>
                  <label className="block text-2xs uppercase text-slate-500 mb-1">Proceeds ($)</label>
                  <input type="number" min="0" step="0.01" value={proceeds} placeholder="0.00"
                    onChange={(e) => { setProceeds(e.target.value); setPreview(null); }}
                    className="w-full px-2 py-1.5 bg-slate-800 border border-slate-700 rounded-lg text-xs text-white font-mono" />
                </div>
              </div>
              {proceeds.trim() !== '' && Number(proceeds) > 0 && (
                <div>
                  <label className="block text-2xs uppercase text-slate-500 mb-1">Receive via</label>
                  <select value={rail} onChange={(e) => { setRail(e.target.value); setPreview(null); }}
                    className="w-full px-2 py-1.5 bg-slate-800 border border-slate-700 rounded-lg text-xs text-white">
                    <option value="ach">Bank / ACH</option>
                    <option value="check">Check</option>
                    <option value="wire">Wire</option>
                    <option value="cash">Cash</option>
                  </select>
                </div>
              )}

              {disposalErr && <p className="text-2xs text-red-400">{disposalErr}</p>}

              {preview && (
                <div className="rounded-md bg-slate-800/40 p-3 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-2xs text-slate-500">Net book value</span>
                    <span className="text-xs font-mono text-slate-300">{formatMoney(preview.net_book_value_cents)}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-2xs text-slate-500">Result</span>
                    <span className={clsx('text-xs font-mono font-semibold flex items-center gap-1',
                      preview.outcome === 'GAIN' ? 'text-emerald-400' : preview.outcome === 'LOSS' ? 'text-red-400' : 'text-slate-300')}>
                      {preview.outcome === 'GAIN' ? <TrendingUp size={12} /> : preview.outcome === 'LOSS' ? <TrendingDown size={12} /> : <Minus size={12} />}
                      {preview.outcome === 'GAIN' ? 'Gain ' : preview.outcome === 'LOSS' ? 'Loss ' : 'Breakeven '}
                      {preview.outcome !== 'BREAKEVEN' && formatMoney(Math.abs(preview.gain_loss_cents))}
                    </span>
                  </div>
                  <div className="border-t border-slate-700/50 pt-2">
                    <p className="text-2xs uppercase text-slate-500 mb-1">Journal entry</p>
                    <table className="w-full text-2xs">
                      <tbody>
                        {preview.lines.map((l, i) => (
                          <tr key={i}>
                            <td className="py-0.5 text-slate-400">{l.memo}</td>
                            <td className="py-0.5 text-right font-mono text-emerald-400">{l.debitCents ? formatMoney(l.debitCents) : ''}</td>
                            <td className="py-0.5 text-right font-mono text-red-400">{l.creditCents ? formatMoney(l.creditCents) : ''}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              <div className="flex items-center gap-2">
                {!preview ? (
                  <button onClick={runPreview} disabled={busy}
                    className="flex-1 px-3 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 rounded-lg text-xs font-medium text-white flex items-center justify-center gap-1">
                    {busy ? <Loader2 size={13} className="animate-spin" /> : 'Preview gain / loss'}
                  </button>
                ) : (
                  <button onClick={confirmDisposal} disabled={busy}
                    className="flex-1 px-3 py-2 bg-red-600 hover:bg-red-500 disabled:opacity-40 rounded-lg text-xs font-medium text-white flex items-center justify-center gap-1">
                    {busy ? <Loader2 size={13} className="animate-spin" /> : 'Confirm & post disposal'}
                  </button>
                )}
                <button onClick={() => { setDisposing(false); setPreview(null); setDisposalErr(null); }}
                  className="px-3 py-2 border border-slate-700 rounded-lg text-xs text-slate-400">Cancel</button>
              </div>
            </div>
          )}
        </DetailSection>
      )}
    </DetailDrawer>
  );
}
