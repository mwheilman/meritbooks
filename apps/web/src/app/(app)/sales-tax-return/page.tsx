'use client';

import { useMemo, useState } from 'react';
import {
  Loader2, AlertCircle, Landmark, Download, Printer, ShieldAlert, CheckCircle2,
  Scale, Info, MapPin,
} from 'lucide-react';
import { clsx } from 'clsx';
import { useQuery } from '@/hooks';
import { PageHeader, EmptyState } from '@/components/ui';

// ── Types mirrored from GET /api/tax/sales-tax-return ────────────────────────────
interface JurisdictionLine {
  jurisdiction: string;
  grossSalesCents: number;
  taxableSalesCents: number;
  exemptSalesCents: number;
  nonTaxableSalesCents: number;
  deductionsCents: number;
  taxCollectedCents: number;
  txnCount: number;
  taxableTxnCount: number;
  exemptTxnCount: number;
  effectiveRatePct: number;
  expectedRatePct: number | null;
  expectedTaxCents: number;
  rateVarianceCents: number;
  rateFlagged: boolean;
  hasExpectedRate: boolean;
  fallbackShare: number;
  localJurisdictions: string[];
}
interface ReturnTotals {
  grossSalesCents: number;
  taxableSalesCents: number;
  exemptSalesCents: number;
  nonTaxableSalesCents: number;
  deductionsCents: number;
  taxCollectedCents: number;
  txnCount: number;
  jurisdictionCount: number;
  rateFlaggedCount: number;
}
interface GlTieOut {
  available: boolean;
  accountNumber: string | null;
  worksheetTaxCents: number;
  glNetCreditCents: number;
  arCreditCents: number;
  remittanceDebitCents: number;
  endingBalanceCents: number;
  varianceCents: number;
  reconciled: boolean;
  note: string | null;
}
interface NexusAlert {
  state: string;
  trailingSalesCents: number | null;
  tier: string | null;
  collectingNow: boolean;
  shouldCollectNotCollecting: boolean;
}
interface ReturnReport {
  window: { startDate: string; endDate: string };
  jurisdictionFilter: string | null;
  locationFilter: string | null;
  worksheet: { lines: JurisdictionLine[]; totals: ReturnTotals };
  allJurisdictionTotals: ReturnTotals;
  glTieOut: GlTieOut;
  nexusAlerts: NexusAlert[];
  meta: {
    invoicesScanned: number;
    invoicesAttributed: number;
    invoicesUnattributed: number;
    fallbackShare: number;
    generatedAt: string;
  };
}

const fmt = (cents: number) => (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const fmtPct = (p: number | null) => (p == null ? '—' : `${p.toFixed(3).replace(/\.?0+$/, '')}%`);

// Quarter helpers for the period presets.
function quarterRange(year: number, q: number): { start: string; end: string } {
  const startMonth = (q - 1) * 3;
  const start = new Date(Date.UTC(year, startMonth, 1));
  const end = new Date(Date.UTC(year, startMonth + 3, 0));
  const iso = (d: Date) => d.toISOString().split('T')[0];
  return { start: iso(start), end: iso(end) };
}

export default function SalesTaxReturnPage() {
  const now = new Date();
  const [startDate, setStartDate] = useState(`${now.getFullYear()}-01-01`);
  const [endDate, setEndDate] = useState(
    new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().split('T')[0],
  );
  const [jurisdiction, setJurisdiction] = useState<string>('all');

  const params = useMemo(() => {
    const p: Record<string, string> = { start_date: startDate, end_date: endDate };
    if (jurisdiction !== 'all') p.jurisdiction = jurisdiction;
    return p;
  }, [startDate, endDate, jurisdiction]);

  const { data, isLoading, error } = useQuery<ReturnReport>('/api/tax/sales-tax-return', params);

  const totals = data?.worksheet?.totals;
  const lines = data?.worksheet?.lines ?? [];
  const gl = data?.glTieOut;

  const setQuarter = (q: number) => {
    const { start, end } = quarterRange(now.getFullYear(), q);
    setStartDate(start);
    setEndDate(end);
  };
  const setCurrentMonth = () => {
    setStartDate(`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`);
    setEndDate(new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().split('T')[0]);
  };

  const exportCsv = () => {
    if (!data) return;
    const header = [
      'Jurisdiction', 'Gross Sales', 'Taxable Sales', 'Exempt Sales', 'Non-Taxable Sales',
      'Total Deductions', 'Tax Collected', 'Effective Rate %', 'Expected Rate %',
      'Expected Tax', 'Rate Variance', 'Flagged', 'Transactions',
    ];
    const money = (c: number) => (c / 100).toFixed(2);
    const rows = (data.worksheet?.lines ?? []).map((l) => [
      l.jurisdiction, money(l.grossSalesCents), money(l.taxableSalesCents), money(l.exemptSalesCents),
      money(l.nonTaxableSalesCents), money(l.deductionsCents), money(l.taxCollectedCents),
      String(l.effectiveRatePct), l.expectedRatePct == null ? '' : String(l.expectedRatePct),
      money(l.expectedTaxCents), money(l.rateVarianceCents), l.rateFlagged ? 'YES' : '', String(l.txnCount),
    ]);
    const t = data.allJurisdictionTotals;
    rows.push([
      'TOTAL', money(t.grossSalesCents), money(t.taxableSalesCents), money(t.exemptSalesCents),
      money(t.nonTaxableSalesCents), money(t.deductionsCents), money(t.taxCollectedCents),
      '', '', '', '', '', String(t.txnCount),
    ]);
    const csv = [header, ...rows].map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `sales-tax-return_${data.window.startDate}_${data.window.endDate}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <PageHeader
        title="Sales Tax Return"
        description="Filing-ready sales/use-tax liability by jurisdiction — taxable vs exempt sales, tax collected, rate reconciliation, and a Sales Tax Payable GL tie-out. Read-only: nothing is registered, filed, or remitted here."
      />

      {/* Controls */}
      <div className="flex flex-wrap items-end gap-3 mb-5 print:hidden">
        <div>
          <label className="text-xs text-slate-400">Period start</label>
          <input type="date" className="input mt-1" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
        </div>
        <div>
          <label className="text-xs text-slate-400">Period end</label>
          <input type="date" className="input mt-1" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
        </div>
        <div>
          <label className="text-xs text-slate-400">Jurisdiction</label>
          <select className="input mt-1 min-w-[8rem]" value={jurisdiction} onChange={(e) => setJurisdiction(e.target.value)}>
            <option value="all">All states</option>
            {data?.allJurisdictionTotals && (data.worksheet?.lines?.length ?? 0) > 0 &&
              [...new Set([jurisdiction !== 'all' ? jurisdiction : '', ...lines.map((l) => l.jurisdiction)].filter(Boolean))]
                .sort()
                .map((s) => <option key={s} value={s}>{s}</option>)}
            {/* fall back to any collecting states surfaced by nexus so the filter is usable pre-load */}
            {data?.nexusAlerts.map((n) => n.state).filter((s) => !lines.some((l) => l.jurisdiction === s)).map((s) => (
              <option key={`nx-${s}`} value={s}>{s}</option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-1 ml-auto">
          {[1, 2, 3, 4].map((q) => (
            <button key={q} onClick={() => setQuarter(q)} className="px-2.5 py-1.5 rounded text-xs font-medium text-slate-400 hover:text-white hover:bg-slate-800">
              Q{q}
            </button>
          ))}
          <button onClick={setCurrentMonth} className="px-2.5 py-1.5 rounded text-xs font-medium text-slate-400 hover:text-white hover:bg-slate-800">
            This month
          </button>
        </div>
      </div>

      {isLoading && (
        <div className="flex items-center justify-center py-20 text-slate-500"><Loader2 className="animate-spin" size={20} /></div>
      )}
      {error && !isLoading && (
        <div className="card p-4 flex items-center gap-2 text-red-400 text-sm"><AlertCircle size={16} /> {error}</div>
      )}

      {!isLoading && !error && data && (
        <div className="space-y-5">
          {/* Export bar */}
          <div className="flex items-center justify-between print:hidden">
            <p className="text-2xs text-slate-500">
              {data.meta.invoicesScanned} invoice{data.meta.invoicesScanned === 1 ? '' : 's'} scanned · {data.meta.invoicesAttributed} attributed to a jurisdiction
              {data.meta.invoicesUnattributed > 0 && <span className="text-amber-400"> · {data.meta.invoicesUnattributed} with no destination</span>}
            </p>
            <div className="flex items-center gap-2">
              <button className="btn btn-ghost btn-sm" onClick={() => window.print()}><Printer size={14} /> Print / PDF</button>
              <button className="btn btn-primary btn-sm" onClick={exportCsv} disabled={lines.length === 0}><Download size={14} /> Export CSV</button>
            </div>
          </div>

          {/* Summary cards */}
          <div className="grid gap-3 sm:grid-cols-4">
            <SummaryCard label="Gross sales" valueCents={totals?.grossSalesCents ?? 0} />
            <SummaryCard label="Taxable sales" valueCents={totals?.taxableSalesCents ?? 0} />
            <SummaryCard label="Exempt / non-taxable" valueCents={totals?.deductionsCents ?? 0} tone="muted" />
            <SummaryCard label="Tax collected" valueCents={totals?.taxCollectedCents ?? 0} emphasize />
          </div>

          {/* Nexus alerts — collect-you-should-but-you-aren't (from EC-7) */}
          {data.nexusAlerts.some((n) => n.shouldCollectNotCollecting) && (
            <section className="card p-4 border-amber-500/40">
              <div className="flex items-start gap-3">
                <ShieldAlert size={18} className="text-amber-400 mt-0.5 shrink-0" />
                <div className="space-y-1.5">
                  <h2 className="text-sm font-semibold text-white">Nexus says you should be collecting here — but aren&apos;t</h2>
                  <p className="text-2xs text-slate-400">
                    The EC-7 economic-nexus tripwire flagged these states, yet no tax was collected in them this period. Confirm registration + start collecting, or dismiss the exception if already registered.
                  </p>
                  <div className="flex flex-wrap gap-2 pt-1">
                    {data.nexusAlerts.filter((n) => n.shouldCollectNotCollecting).map((n) => (
                      <span key={n.state} className="badge bg-amber-500/10 text-amber-300 inline-flex items-center gap-1.5">
                        <MapPin size={11} /> {n.state}
                        {n.trailingSalesCents != null && <span className="text-amber-400/70">· {fmt(n.trailingSalesCents)} trailing</span>}
                        {n.tier && <span className="uppercase text-2xs text-amber-400/60">{n.tier}</span>}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
            </section>
          )}

          {lines.length === 0 ? (
            <EmptyState
              icon={Landmark}
              title="No taxed or attributable sales in this period"
              description="No invoices in this window resolve to a taxing jurisdiction. Widen the period, clear the jurisdiction filter, or add ship-to addresses to invoices so destination-based tax can be attributed."
            />
          ) : (
            <>
              {/* Per-jurisdiction liability table */}
              <section className="card overflow-hidden">
                <div className="px-4 py-3 border-b border-slate-800 flex items-center justify-between">
                  <div>
                    <h2 className="text-sm font-semibold text-white">Liability by jurisdiction</h2>
                    <p className="text-2xs text-slate-500 mt-0.5">
                      {data.window.startDate} → {data.window.endDate} · {totals?.jurisdictionCount ?? 0} jurisdiction{(totals?.jurisdictionCount ?? 0) === 1 ? '' : 's'}
                      {(totals?.rateFlaggedCount ?? 0) > 0 && <span className="text-amber-400"> · {totals?.rateFlaggedCount} rate variance{totals?.rateFlaggedCount === 1 ? '' : 's'} flagged</span>}
                    </p>
                  </div>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="text-2xs uppercase tracking-wide text-slate-500 border-b border-slate-800">
                      <tr>
                        <th className="text-left font-medium px-4 py-2.5">Jurisdiction</th>
                        <th className="text-right font-medium px-4 py-2.5">Gross</th>
                        <th className="text-right font-medium px-4 py-2.5">Taxable</th>
                        <th className="text-right font-medium px-4 py-2.5">Exempt / non-tax</th>
                        <th className="text-right font-medium px-4 py-2.5">Tax collected</th>
                        <th className="text-right font-medium px-4 py-2.5">Eff. rate</th>
                        <th className="text-right font-medium px-4 py-2.5">Rate check</th>
                      </tr>
                    </thead>
                    <tbody>
                      {lines.map((l) => <JurisdictionRow key={l.jurisdiction} line={l} />)}
                    </tbody>
                    {totals && (
                      <tfoot>
                        <tr className="border-t-2 border-slate-700 bg-slate-900/40 font-semibold">
                          <td className="px-4 py-3 text-white">Total {data.jurisdictionFilter ? `(${data.jurisdictionFilter})` : ''}</td>
                          <td className="px-4 py-3 text-right font-mono text-slate-200">{fmt(totals.grossSalesCents)}</td>
                          <td className="px-4 py-3 text-right font-mono text-slate-200">{fmt(totals.taxableSalesCents)}</td>
                          <td className="px-4 py-3 text-right font-mono text-slate-400">{fmt(totals.deductionsCents)}</td>
                          <td className="px-4 py-3 text-right font-mono text-emerald-300">{fmt(totals.taxCollectedCents)}</td>
                          <td className="px-4 py-3" colSpan={2} />
                        </tr>
                      </tfoot>
                    )}
                  </table>
                </div>
              </section>

              {/* Taxable / exempt breakdown detail */}
              <section className="card overflow-hidden">
                <div className="px-4 py-3 border-b border-slate-800">
                  <h2 className="text-sm font-semibold text-white">Taxable vs exempt breakdown</h2>
                  <p className="text-2xs text-slate-500 mt-0.5">Every non-taxed dollar a return deducts from gross, split into genuinely exempt (resale/nonprofit) vs simply untaxed.</p>
                </div>
                <table className="w-full text-sm">
                  <thead className="text-2xs uppercase tracking-wide text-slate-500 border-b border-slate-800">
                    <tr>
                      <th className="text-left font-medium px-4 py-2.5">Jurisdiction</th>
                      <th className="text-right font-medium px-4 py-2.5">Taxable</th>
                      <th className="text-right font-medium px-4 py-2.5">Exempt (certificate)</th>
                      <th className="text-right font-medium px-4 py-2.5">Non-taxable</th>
                      <th className="text-right font-medium px-4 py-2.5">Txns (taxable/exempt)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map((l) => (
                      <tr key={l.jurisdiction} className="border-b border-slate-800/40 last:border-0">
                        <td className="px-4 py-2.5 text-slate-200 font-medium">
                          {l.jurisdiction}
                          {l.localJurisdictions.length > 0 && <span className="ml-2 text-2xs text-slate-600">{l.localJurisdictions.join(', ')}</span>}
                          {l.fallbackShare > 0 && (
                            <span className="ml-2 text-2xs text-amber-400/70" title="Share of taxable base whose destination was inferred from the customer's address, not an explicit ship-to.">
                              {Math.round(l.fallbackShare * 100)}% inferred dest.
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-2.5 text-right font-mono text-slate-200">{fmt(l.taxableSalesCents)}</td>
                        <td className="px-4 py-2.5 text-right font-mono text-slate-400">{fmt(l.exemptSalesCents)}</td>
                        <td className="px-4 py-2.5 text-right font-mono text-slate-400">{fmt(l.nonTaxableSalesCents)}</td>
                        <td className="px-4 py-2.5 text-right font-mono text-slate-500">{l.taxableTxnCount} / {l.exemptTxnCount}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>

              {/* GL tie-out */}
              <section className="card overflow-hidden">
                <div className="px-4 py-3 border-b border-slate-800 flex items-center gap-2">
                  <Scale size={15} className="text-slate-400" />
                  <div>
                    <h2 className="text-sm font-semibold text-white">GL tie-out — Sales Tax Payable{gl?.accountNumber ? ` (${gl.accountNumber})` : ''}</h2>
                    <p className="text-2xs text-slate-500 mt-0.5">Reconciles worksheet collected tax to the invoice-sourced credits posted to the liability account (all jurisdictions).</p>
                  </div>
                </div>
                {!gl?.available ? (
                  <div className="p-4 flex items-start gap-2 text-amber-400 text-sm">
                    <Info size={15} className="mt-0.5 shrink-0" /> {gl?.note ?? 'GL tie-out unavailable.'}
                  </div>
                ) : (
                  <div className="p-4 space-y-3">
                    <div className={clsx(
                      'flex items-center gap-2 text-sm font-medium',
                      gl.reconciled ? 'text-emerald-300' : 'text-amber-300',
                    )}>
                      {gl.reconciled ? <CheckCircle2 size={16} /> : <ShieldAlert size={16} />}
                      {gl.reconciled
                        ? 'Worksheet ties to the ledger.'
                        : `Out of balance by ${fmt(Math.abs(gl.varianceCents))} — ${gl.note ?? 'investigate.'}`}
                    </div>
                    <div className="grid gap-3 sm:grid-cols-4">
                      <TieCell label="Worksheet tax collected" valueCents={gl.worksheetTaxCents} />
                      <TieCell label="Invoice credits to payable" valueCents={gl.arCreditCents} />
                      <TieCell label="Remittances (period debits)" valueCents={gl.remittanceDebitCents} tone="muted" />
                      <TieCell label="Payable balance (period end)" valueCents={gl.endingBalanceCents} emphasize />
                    </div>
                  </div>
                )}
              </section>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function SummaryCard(props: { label: string; valueCents: number; tone?: 'muted'; emphasize?: boolean }) {
  const { label, valueCents, tone, emphasize } = props;
  return (
    <div className={clsx('card p-3', emphasize && 'border-emerald-500/40')}>
      <p className="text-2xs uppercase tracking-wide text-slate-500">{label}</p>
      <p className={clsx('mt-1 font-mono text-lg', emphasize ? 'text-emerald-300' : tone === 'muted' ? 'text-slate-400' : 'text-white')}>
        {fmt(valueCents)}
      </p>
    </div>
  );
}

function TieCell(props: { label: string; valueCents: number; tone?: 'muted'; emphasize?: boolean }) {
  const { label, valueCents, tone, emphasize } = props;
  return (
    <div>
      <p className="text-2xs uppercase tracking-wide text-slate-500">{label}</p>
      <p className={clsx('mt-0.5 font-mono text-sm', emphasize ? 'text-white' : tone === 'muted' ? 'text-slate-400' : 'text-slate-200')}>
        {fmt(valueCents)}
      </p>
    </div>
  );
}

function JurisdictionRow({ line }: { line: JurisdictionLine }) {
  return (
    <tr className="border-b border-slate-800/40 last:border-0 hover:bg-slate-900/30">
      <td className="px-4 py-2.5">
        <span className="text-slate-200 font-medium">{line.jurisdiction}</span>
        <span className="ml-2 text-2xs text-slate-600">{line.txnCount} txn{line.txnCount === 1 ? '' : 's'}</span>
      </td>
      <td className="px-4 py-2.5 text-right font-mono text-slate-300">{fmt(line.grossSalesCents)}</td>
      <td className="px-4 py-2.5 text-right font-mono text-slate-200">{fmt(line.taxableSalesCents)}</td>
      <td className="px-4 py-2.5 text-right font-mono text-slate-400">{fmt(line.deductionsCents)}</td>
      <td className="px-4 py-2.5 text-right font-mono text-emerald-300">{fmt(line.taxCollectedCents)}</td>
      <td className="px-4 py-2.5 text-right font-mono text-slate-300">{fmtPct(line.effectiveRatePct)}</td>
      <td className="px-4 py-2.5 text-right">
        {!line.hasExpectedRate ? (
          <span className="text-2xs text-slate-600" title="No expected statutory rate on file for these sales.">no rate</span>
        ) : line.rateFlagged ? (
          <span className="badge bg-amber-500/10 text-amber-300 inline-flex items-center gap-1" title={`Expected ${fmtPct(line.expectedRatePct)} → ${fmt(line.expectedTaxCents)}`}>
            <ShieldAlert size={10} /> {line.rateVarianceCents < 0 ? 'under' : 'over'} {fmt(Math.abs(line.rateVarianceCents))}
          </span>
        ) : (
          <span className="badge badge-neutral inline-flex items-center gap-1"><CheckCircle2 size={10} /> ties</span>
        )}
      </td>
    </tr>
  );
}
