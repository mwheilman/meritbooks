'use client';

import { useMemo, useState } from 'react';
import {
  Loader2, AlertCircle, Landmark, Info, ArrowUpRight, ArrowDownRight, CheckCircle2, Send, FileCheck,
} from 'lucide-react';
import { clsx } from 'clsx';
import { useQuery, addToast } from '@/hooks';
import { api } from '@/lib/api-client';
import { PageHeader, EmptyState } from '@/components/ui';
import { HubTabs } from '../_components/hub-tabs';

// ── Types mirrored from /api/tax/provision ─────────────────────────────────────
interface ProvisionResult {
  pretaxBookIncomeCents: number;
  statutoryRatePct: number;
  permanentNetCents: number;
  temporaryNetCents: number;
  taxableIncomeCents: number;
  currentTaxCents: number;
  deferredTaxCents: number;
  totalProvisionCents: number;
  dtaChangeCents: number;
  dtlChangeCents: number;
  netDeferredTaxAssetCents: number;
  statutoryTaxCents: number;
  permanentTaxEffectCents: number;
  effectiveRatePct: number;
}
interface M1Summary {
  totalAdditionsCents: number;
  totalSubtractionsCents: number;
  adjustmentCount: number;
}
interface DeferredItem {
  code: string;
  label: string;
  temporaryDiffCents: number;
  deferredTaxCents: number;
  category: 'DTA' | 'DTL';
}
interface Rollforward {
  beginningDtaCents: number;
  beginningDtlCents: number;
  dtaChangeCents: number;
  dtlChangeCents: number;
  endingDtaCents: number;
  endingDtlCents: number;
  endingNetDtaCents: number;
  hasPriorHistory: boolean;
}
interface SavedProvision {
  id: string;
  status: string;
  gl_entry_id: string | null;
  total_provision_cents: number;
}
interface Computation {
  startDate: string;
  endDate: string;
  locationId: string | null;
  result: ProvisionResult;
  m1: M1Summary;
  deferredItems: DeferredItem[];
  rollforward: Rollforward;
  missingAccounts: string[];
  saved: SavedProvision | null;
}
interface LocationOption { id: string; name: string }

const fmt = (cents: number) =>
  (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const signed = (cents: number) => `${cents < 0 ? '−' : ''}${fmt(Math.abs(cents))}`;

export default function TaxProvisionPage() {
  const now = new Date();
  const [startDate, setStartDate] = useState(`${now.getFullYear()}-01-01`);
  const [endDate, setEndDate] = useState(`${now.getFullYear()}-12-31`);
  const [rate, setRate] = useState('21');
  const [locationId, setLocationId] = useState<string>('all');
  const [busy, setBusy] = useState<null | 'propose' | 'post'>(null);
  const [proposedId, setProposedId] = useState<string | null>(null);
  const [postedEntry, setPostedEntry] = useState<string | null>(null);

  const { data: locations } = useQuery<LocationOption[]>('/api/locations');

  const params = useMemo(
    () => ({ start_date: startDate, end_date: endDate, statutory_rate: rate, location_id: locationId }),
    [startDate, endDate, rate, locationId],
  );
  const { data, isLoading, error, refetch } = useQuery<{ data: Computation }>('/api/tax/provision', params);
  const comp = data?.data;
  const r = comp?.result;

  const alreadyPosted = comp?.saved?.status === 'POSTED' || !!postedEntry;
  const canPost = !!(proposedId || comp?.saved?.id) && locationId !== 'all' && (comp?.missingAccounts.length ?? 1) === 0 && !alreadyPosted;

  const propose = async () => {
    setBusy('propose');
    const res = await api.post<{ data: { provision: { id: string } } }>('/api/tax/provision', {
      action: 'propose',
      start_date: startDate,
      end_date: endDate,
      statutory_rate: Number(rate),
      location_id: locationId === 'all' ? null : locationId,
    });
    setBusy(null);
    if (res.error) { addToast('error', res.error.error); return; }
    setProposedId(res.data?.data.provision.id ?? null);
    setPostedEntry(null);
    addToast('success', 'Provision proposed — review and post the journal entry');
    refetch();
  };

  const post = async () => {
    const id = proposedId ?? comp?.saved?.id;
    if (!id) return;
    setBusy('post');
    const res = await api.post<{ data: { entryNumber: string | null; alreadyPosted: boolean } }>(
      '/api/tax/provision',
      { action: 'post', provision_id: id },
    );
    setBusy(null);
    if (res.error) { addToast('error', res.error.error); return; }
    setPostedEntry(res.data?.data.entryNumber ?? 'posted');
    addToast('success', res.data?.data.alreadyPosted ? 'Already posted' : 'Provision journal entry posted');
    refetch();
  };

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <PageHeader
        title="Income Tax Provision (ASC 740)"
        description="Current + deferred tax from the book-to-tax differences. The ledger computes the numbers from book net income and the Schedule M-1 permanent/temporary split; a human approves and posts the balanced provision entry."
      />

      <HubTabs section="tax" />

      {/* Controls */}
      <div className="flex flex-wrap items-end gap-3 mb-5">
        <div>
          <label className="text-xs text-slate-400">Period start</label>
          <input type="date" className="input mt-1" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
        </div>
        <div>
          <label className="text-xs text-slate-400">Period end</label>
          <input type="date" className="input mt-1" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
        </div>
        <div>
          <label className="text-xs text-slate-400">Statutory rate %</label>
          <input
            type="number" step="0.001" min="0" max="100"
            className="input mt-1 w-28 font-mono"
            value={rate}
            onChange={(e) => setRate(e.target.value)}
          />
        </div>
        <div>
          <label className="text-xs text-slate-400">Company / entity</label>
          <select className="input mt-1 max-w-xs" value={locationId} onChange={(e) => { setLocationId(e.target.value); setProposedId(null); setPostedEntry(null); }}>
            <option value="all">All (consolidated preview — not postable)</option>
            {(locations ?? []).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        </div>
      </div>

      {isLoading && (
        <div className="flex items-center justify-center py-20 text-slate-500"><Loader2 className="animate-spin" size={20} /></div>
      )}
      {error && !isLoading && (
        <div className="card p-4 flex items-center gap-2 text-red-400 text-sm"><AlertCircle size={16} /> {error}</div>
      )}

      {!isLoading && !error && comp && r && (
        <div className="space-y-5">
          {/* Summary cards */}
          <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
            <SummaryCard label="Pretax book income" valueCents={r.pretaxBookIncomeCents} />
            <SummaryCard label="Current tax" valueCents={r.currentTaxCents} tone="add" />
            <SummaryCard label="Deferred tax" valueCents={r.deferredTaxCents} tone={r.deferredTaxCents >= 0 ? 'add' : 'sub'} />
            <SummaryCard label="Total provision" valueCents={r.totalProvisionCents} emphasize />
            <SummaryCard label="Effective rate" rawText={`${r.effectiveRatePct.toFixed(2)}%`} />
          </div>

          {comp.m1.adjustmentCount === 0 && (
            <div className="card p-4 flex items-start gap-3 border-blue-500/30">
              <Info size={16} className="text-blue-400 mt-0.5 shrink-0" />
              <div className="text-sm text-slate-300">
                No book-tax differences are tagged for this period, so taxable income equals book income and the provision is a
                straight <span className="text-white font-medium">{r.statutoryRatePct}% </span> of pretax income with no deferred component.
                Tag accounts on the <span className="text-emerald-400">Book-to-Tax</span> screen to build the M-1 and drive DTA/DTL.
              </div>
            </div>
          )}

          {/* Current vs deferred breakdown */}
          <section className="card overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-800">
              <h2 className="text-sm font-semibold text-white">Provision breakdown — current & deferred</h2>
            </div>
            <table className="w-full text-sm">
              <tbody>
                <Row label="Net income per books" amountCents={r.pretaxBookIncomeCents} />
                <Row label="Permanent differences (net)" amountCents={r.permanentNetCents} indent muted />
                <Row label="Temporary differences (net)" amountCents={r.temporaryNetCents} indent muted />
                <Row label="Taxable income" amountCents={r.taxableIncomeCents} bold divide />
                <Row label={`Current tax @ ${r.statutoryRatePct}%`} amountCents={r.currentTaxCents} />
                <Row label="Deferred tax (Δ DTL − Δ DTA)" amountCents={r.deferredTaxCents} />
                <tr className="border-t-2 border-slate-700 bg-slate-900/40">
                  <td className="px-4 py-3 font-semibold text-white">Total income tax provision</td>
                  <td className="px-4 py-3 text-right font-mono font-semibold text-emerald-300">{signed(r.totalProvisionCents)}</td>
                </tr>
              </tbody>
            </table>
          </section>

          <div className="grid gap-5 lg:grid-cols-2">
            {/* Effective-rate reconciliation */}
            <section className="card overflow-hidden">
              <div className="px-4 py-3 border-b border-slate-800">
                <h2 className="text-sm font-semibold text-white">Effective-rate reconciliation</h2>
                <p className="text-2xs text-slate-500 mt-0.5">Only permanent differences move the rate away from statutory.</p>
              </div>
              <table className="w-full text-sm">
                <tbody>
                  <ReconRow label="Tax at statutory rate" amountCents={r.statutoryTaxCents} pct={r.pretaxBookIncomeCents !== 0 ? r.statutoryRatePct : 0} />
                  <ReconRow label="Effect of permanent differences" amountCents={r.permanentTaxEffectCents} pct={r.pretaxBookIncomeCents !== 0 ? +(r.permanentTaxEffectCents / r.pretaxBookIncomeCents * 100).toFixed(2) : 0} />
                  <tr className="border-t-2 border-slate-700 bg-slate-900/40">
                    <td className="px-4 py-2.5 font-semibold text-white">Total provision</td>
                    <td className="px-4 py-2.5 text-right font-mono text-white">{signed(r.totalProvisionCents)}</td>
                    <td className="px-4 py-2.5 text-right font-mono text-emerald-300">{r.effectiveRatePct.toFixed(2)}%</td>
                  </tr>
                </tbody>
              </table>
            </section>

            {/* DTA / DTL rollforward + roll */}
            <section className="card overflow-hidden">
              <div className="px-4 py-3 border-b border-slate-800">
                <h2 className="text-sm font-semibold text-white">Deferred tax rollforward — DTA / DTL</h2>
                <p className="text-2xs text-slate-500 mt-0.5">
                  {comp.rollforward?.hasPriorHistory
                    ? 'Beginning balances carried from prior filed provisions for this entity.'
                    : 'No prior provisions on file — beginning balances are zero.'}
                </p>
              </div>
              <table className="w-full text-sm">
                <thead className="text-2xs uppercase tracking-wide text-slate-500 border-b border-slate-800">
                  <tr>
                    <th className="text-left font-medium px-4 py-2.5">Deferred balance</th>
                    <th className="text-right font-medium px-4 py-2.5">DTA</th>
                    <th className="text-right font-medium px-4 py-2.5">DTL</th>
                  </tr>
                </thead>
                <tbody>
                  <RollRow label="Beginning balance" dta={comp.rollforward?.beginningDtaCents ?? 0} dtl={comp.rollforward?.beginningDtlCents ?? 0} />
                  <RollRow label="Change this period" dta={comp.rollforward?.dtaChangeCents ?? r.dtaChangeCents} dtl={comp.rollforward?.dtlChangeCents ?? r.dtlChangeCents} />
                  <tr className="border-t border-slate-700 bg-slate-900/40">
                    <td className="px-4 py-2.5 font-semibold text-white">Ending balance</td>
                    <td className="px-4 py-2.5 text-right font-mono font-semibold text-emerald-300">{fmt(comp.rollforward?.endingDtaCents ?? r.dtaChangeCents)}</td>
                    <td className="px-4 py-2.5 text-right font-mono font-semibold text-red-300">{fmt(comp.rollforward?.endingDtlCents ?? r.dtlChangeCents)}</td>
                  </tr>
                  <tr>
                    <td className="px-4 py-2 text-xs text-slate-400">Net deferred tax asset (liability)</td>
                    <td colSpan={2} className={clsx('px-4 py-2 text-right font-mono', (comp.rollforward?.endingNetDtaCents ?? 0) >= 0 ? 'text-emerald-400' : 'text-red-400')}>
                      {signed(comp.rollforward?.endingNetDtaCents ?? (r.dtaChangeCents - r.dtlChangeCents))}
                    </td>
                  </tr>
                </tbody>
              </table>
              <div className="px-4 pt-3 pb-1 border-t border-slate-800 text-2xs uppercase tracking-wide text-slate-500">
                Temporary difference detail — this period (× {r.statutoryRatePct}%)
              </div>
              {comp.deferredItems.length === 0 ? (
                <div className="px-4 py-4 text-sm text-slate-500">No temporary differences this period.</div>
              ) : (
                <table className="w-full text-sm">
                  <thead className="text-2xs uppercase tracking-wide text-slate-500 border-b border-slate-800">
                    <tr>
                      <th className="text-left font-medium px-4 py-2.5">Difference</th>
                      <th className="text-right font-medium px-4 py-2.5">Temp diff</th>
                      <th className="text-right font-medium px-4 py-2.5">Deferred tax</th>
                      <th className="text-right font-medium px-4 py-2.5">→</th>
                    </tr>
                  </thead>
                  <tbody>
                    {comp.deferredItems.map((it) => (
                      <tr key={it.code} className="border-b border-slate-800/40 last:border-0">
                        <td className="px-4 py-2 text-slate-300">
                          {it.category === 'DTA' ? <ArrowUpRight size={12} className="inline text-emerald-400/70 mr-1" /> : <ArrowDownRight size={12} className="inline text-red-400/70 mr-1" />}
                          {it.label || it.code}
                        </td>
                        <td className="px-4 py-2 text-right font-mono text-slate-300">{signed(it.temporaryDiffCents)}</td>
                        <td className="px-4 py-2 text-right font-mono text-slate-200">{fmt(it.deferredTaxCents)}</td>
                        <td className="px-4 py-2 text-right"><span className={clsx('badge', it.category === 'DTA' ? 'badge-info' : 'badge-neutral')}>{it.category}</span></td>
                      </tr>
                    ))}
                    <tr className="border-t border-slate-700 bg-slate-900/40 text-xs">
                      <td className="px-4 py-2 text-slate-400">Δ Deferred tax asset / liability</td>
                      <td />
                      <td className="px-4 py-2 text-right font-mono text-emerald-400">DTA {fmt(r.dtaChangeCents)}</td>
                      <td className="px-4 py-2 text-right font-mono text-red-400">DTL {fmt(r.dtlChangeCents)}</td>
                    </tr>
                  </tbody>
                </table>
              )}
            </section>
          </div>

          {/* Provision JE preview + propose/post */}
          <section className="card overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-800">
              <h2 className="text-sm font-semibold text-white">Provision journal entry</h2>
              <p className="text-2xs text-slate-500 mt-0.5">DR Income Tax Expense · CR Income Taxes Payable + DR/CR Deferred Tax Asset/Liability — balanced, posted on approval.</p>
            </div>
            <table className="w-full text-sm">
              <tbody>
                <JeRow label="Income Tax Expense" debit={r.totalProvisionCents >= 0 ? r.totalProvisionCents : 0} credit={r.totalProvisionCents < 0 ? -r.totalProvisionCents : 0} />
                <JeRow label="Income Taxes Payable" debit={r.currentTaxCents < 0 ? -r.currentTaxCents : 0} credit={r.currentTaxCents >= 0 ? r.currentTaxCents : 0} />
                {r.dtaChangeCents !== 0 && <JeRow label="Deferred Tax Asset" debit={r.dtaChangeCents} credit={0} />}
                {r.dtlChangeCents !== 0 && <JeRow label="Deferred Tax Liability" debit={0} credit={r.dtlChangeCents} />}
              </tbody>
            </table>

            {comp.missingAccounts.length > 0 && (
              <div className="px-4 py-3 border-t border-slate-800 flex items-start gap-2 text-amber-400 text-xs">
                <AlertCircle size={14} className="mt-0.5 shrink-0" />
                <span>Posting is blocked until these accounts exist in the chart of accounts: {comp.missingAccounts.join('; ')}.</span>
              </div>
            )}

            <div className="px-4 py-3 border-t border-slate-800 flex flex-wrap items-center gap-3">
              {alreadyPosted ? (
                <span className="inline-flex items-center gap-2 text-emerald-400 text-sm"><CheckCircle2 size={15} /> Posted{postedEntry && postedEntry !== 'posted' ? ` — ${postedEntry}` : ''}</span>
              ) : (
                <>
                  <button className="btn btn-secondary btn-sm" onClick={propose} disabled={busy !== null}>
                    {busy === 'propose' ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />} Propose provision
                  </button>
                  <button className="btn btn-primary btn-sm" onClick={post} disabled={busy !== null || !canPost} title={locationId === 'all' ? 'Select a company/entity to post' : undefined}>
                    {busy === 'post' ? <Loader2 size={14} className="animate-spin" /> : <FileCheck size={14} />} Post journal entry
                  </button>
                  {(proposedId || comp.saved?.status === 'PROPOSED') && <span className="text-2xs text-slate-500">Proposed — ready to post.</span>}
                  {locationId === 'all' && <span className="text-2xs text-slate-500">Select a company/entity to enable posting.</span>}
                </>
              )}
            </div>
          </section>
        </div>
      )}

      {!isLoading && !error && !comp && (
        <EmptyState icon={Landmark} title="No data" description="Choose a period and rate to compute the provision." />
      )}
    </div>
  );
}

function SummaryCard(props: { label: string; valueCents?: number; rawText?: string; tone?: 'add' | 'sub'; emphasize?: boolean }) {
  const { label, valueCents, rawText, tone, emphasize } = props;
  return (
    <div className={clsx('card p-3', emphasize && 'border-emerald-500/40')}>
      <p className="text-2xs uppercase tracking-wide text-slate-500">{label}</p>
      <p className={clsx('mt-1 font-mono text-lg', emphasize ? 'text-emerald-300' : tone === 'add' ? 'text-emerald-400' : tone === 'sub' ? 'text-red-400' : 'text-white')}>
        {rawText ?? (valueCents !== undefined ? signed(valueCents) : '—')}
      </p>
    </div>
  );
}

function Row(props: { label: string; amountCents: number; bold?: boolean; indent?: boolean; muted?: boolean; divide?: boolean }) {
  return (
    <tr className={clsx(props.divide && 'border-t border-slate-700')}>
      <td className={clsx('px-4 py-2.5', props.indent && 'pl-8', props.bold ? 'font-semibold text-white' : props.muted ? 'text-slate-400' : 'text-slate-300')}>{props.label}</td>
      <td className={clsx('px-4 py-2.5 text-right font-mono', props.bold ? 'font-semibold text-white' : props.muted ? 'text-slate-400' : 'text-slate-200')}>{signed(props.amountCents)}</td>
    </tr>
  );
}

function ReconRow(props: { label: string; amountCents: number; pct: number }) {
  return (
    <tr className="border-b border-slate-800/40">
      <td className="px-4 py-2.5 text-slate-300">{props.label}</td>
      <td className="px-4 py-2.5 text-right font-mono text-slate-200">{signed(props.amountCents)}</td>
      <td className="px-4 py-2.5 text-right font-mono text-slate-400">{props.pct.toFixed(2)}%</td>
    </tr>
  );
}

function JeRow(props: { label: string; debit: number; credit: number }) {
  return (
    <tr className="border-b border-slate-800/40 last:border-0">
      <td className="px-4 py-2 text-slate-300">{props.label}</td>
      <td className="px-4 py-2 text-right font-mono text-emerald-400">{props.debit ? fmt(props.debit) : ''}</td>
      <td className="px-4 py-2 text-right font-mono text-red-400">{props.credit ? fmt(props.credit) : ''}</td>
    </tr>
  );
}

function RollRow(props: { label: string; dta: number; dtl: number }) {
  return (
    <tr className="border-b border-slate-800/40">
      <td className="px-4 py-2 text-slate-300">{props.label}</td>
      <td className="px-4 py-2 text-right font-mono text-slate-200">{signed(props.dta)}</td>
      <td className="px-4 py-2 text-right font-mono text-slate-200">{signed(props.dtl)}</td>
    </tr>
  );
}
