'use client';

import { useMemo, useState, type ReactNode } from 'react';
import Link from 'next/link';
import {
  ArrowLeft,
  Loader2,
  AlertCircle,
  Landmark,
  Download,
  FileText,
  Sheet,
  Table as TableIcon,
  RotateCcw,
  AlertTriangle,
  Info,
} from 'lucide-react';
import { clsx } from 'clsx';
import { useQuery } from '@/hooks';
import { addToast } from '@/hooks';
import { formatMoney, dollarsToCents } from '@meritbooks/shared';
import { PageHeader } from '@/components/ui';
import { CompanyScopeGuard } from '@/components/company-scope-guard';
import { useActiveCompany } from '@/lib/hooks/use-active-company';
import { useMe } from '@/lib/hooks/use-me';
import { canConsolidate } from '@/lib/company-scope';
import {
  computeBorrowingBase,
  DEFAULT_PARAMS,
  type ArInvoiceInput,
  type BorrowingBaseParams,
  type BorrowingBaseResult,
} from '@/lib/borrowing-base/calc';
import {
  buildExportFilename,
  type StatementModel,
  type StmtRow,
} from '@/lib/reports/export/statement-model';
import { toCsv, downloadBlob } from '@/lib/reports/export/csv';

interface CollateralResponse {
  arInvoices: ArInvoiceInput[];
  inventoryValueCents: number;
  inventoryItemCount: number;
  inventoryDegraded: boolean;
  arInvoiceCount: number;
  asOf: string;
  generatedAt: string;
}

// Form state carries the raw string a user typed; parsing happens in `params`.
interface FormState {
  arAdvancePct: string;
  inventoryAdvancePct: string;
  agingCutoffDays: string;
  concentrationCapPct: string;
  crossAgeTaint: boolean;
  inventorySublimitDollars: string;
  facilityLimitDollars: string;
  outstandingDollars: string;
}

const DEFAULT_FORM: FormState = {
  arAdvancePct: '80',
  inventoryAdvancePct: '50',
  agingCutoffDays: '90',
  concentrationCapPct: '20',
  crossAgeTaint: false,
  inventorySublimitDollars: '',
  facilityLimitDollars: '',
  outstandingDollars: '',
};

function pctToRate(s: string, fallback: number): number {
  const n = parseFloat(s);
  return Number.isFinite(n) ? n / 100 : fallback;
}
function dollarsFieldToCents(s: string): number | null {
  const t = s.trim();
  if (t === '') return null;
  const n = parseFloat(t.replace(/[,$\s]/g, ''));
  if (!Number.isFinite(n)) return null;
  return dollarsToCents(n);
}
function intField(s: string, fallback: number): number {
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : fallback;
}

export default function BorrowingBasePage() {
  const { isAll, ready } = useActiveCompany();
  const { user, loading: meLoading } = useMe();

  // Reports may consolidate — but only for leadership/admins. Everyone else must
  // pin a company (reuse the standard control-guard prompt).
  if (!ready || meLoading) {
    return (
      <div className="flex items-center justify-center py-24 text-slate-500">
        <Loader2 className="animate-spin" size={22} />
      </div>
    );
  }
  if (isAll && !canConsolidate(user)) {
    return (
      <CompanyScopeGuard
        title="Select a company for the borrowing base"
        description="A borrowing-base certificate is prepared per borrowing entity. Choose the company whose collateral you want to certify."
      >
        {null}
      </CompanyScopeGuard>
    );
  }

  return <BorrowingBaseInner consolidated={isAll} />;
}

function BorrowingBaseInner({ consolidated }: { consolidated: boolean }) {
  const { activeCompany } = useActiveCompany();
  const { orgName } = useMe();
  const [form, setForm] = useState<FormState>(DEFAULT_FORM);

  const { data, isLoading, error, refetch } = useQuery<CollateralResponse>('/api/borrowing-base');

  const params: BorrowingBaseParams = useMemo(
    () => ({
      arAdvanceRate: pctToRate(form.arAdvancePct, DEFAULT_PARAMS.arAdvanceRate),
      inventoryAdvanceRate: pctToRate(form.inventoryAdvancePct, DEFAULT_PARAMS.inventoryAdvanceRate),
      agingCutoffDays: intField(form.agingCutoffDays, DEFAULT_PARAMS.agingCutoffDays),
      concentrationCapPct: pctToRate(form.concentrationCapPct, DEFAULT_PARAMS.concentrationCapPct),
      crossAgeTaint: form.crossAgeTaint,
      inventorySublimitCents: dollarsFieldToCents(form.inventorySublimitDollars),
      facilityLimitCents: dollarsFieldToCents(form.facilityLimitDollars),
      outstandingCents: dollarsFieldToCents(form.outstandingDollars) ?? 0,
    }),
    [form],
  );

  const result: BorrowingBaseResult | null = useMemo(() => {
    if (!data) return null;
    return computeBorrowingBase(
      { arInvoices: data.arInvoices, inventoryValueCents: data.inventoryValueCents, asOf: data.asOf },
      params,
    );
  }, [data, params]);

  const entityLabel = consolidated
    ? `${orgName ?? 'All companies'} — Consolidated`
    : activeCompany?.name ?? orgName ?? 'Company';

  const hasCollateral =
    !!data && (data.arInvoices.length > 0 || data.inventoryValueCents > 0);

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  // ── Export ──────────────────────────────────────────────────────────────────
  const [busy, setBusy] = useState<'pdf' | 'xlsx' | 'csv' | null>(null);

  const buildModel = (): StatementModel | null => {
    if (!result) return null;
    const rows: StmtRow[] = [];
    const acct = (label: string, cents: number, indent = 1): StmtRow => ({
      kind: 'account', label, indent, values: [cents],
    });
    const sub = (label: string, cents: number): StmtRow => ({ kind: 'subtotal', label, values: [cents] });

    rows.push({ kind: 'section', label: 'Accounts receivable', values: [null] });
    rows.push(acct('Gross accounts receivable', result.grossArCents));
    rows.push(acct(`Less: past due over ${result.agingCutoffDays} days`, -result.arPastDueIneligibleCents));
    if (result.crossAgeTaint && result.arCrossAgeIneligibleCents > 0) {
      rows.push({ kind: 'account', label: 'incl. cross-age taint carve-out', indent: 2, values: [-result.arCrossAgeIneligibleCents] });
    }
    rows.push(acct(`Less: concentration excess over ${(result.concentrationCapPct * 100).toFixed(0)}%`, -result.arConcentrationIneligibleCents));
    rows.push(sub('Eligible accounts receivable', result.eligibleArCents));
    rows.push(acct(`AR availability @ ${(result.arAdvanceRate * 100).toFixed(1)}%`, result.arAvailabilityCents));

    rows.push({ kind: 'spacer', label: '', values: [] });
    rows.push({ kind: 'section', label: 'Inventory', values: [null] });
    rows.push(acct('On-hand inventory at cost', result.inventoryValueCents));
    rows.push(acct(`Advance @ ${(result.inventoryAdvanceRate * 100).toFixed(1)}%`, result.inventoryUncappedAvailabilityCents));
    if (result.inventorySublimitCents !== null) {
      rows.push(acct('Less: inventory sublimit', -result.inventorySublimitAppliedCents));
    }
    rows.push(sub('Inventory availability', result.inventoryAvailabilityCents));

    rows.push({ kind: 'spacer', label: '', values: [] });
    rows.push({ kind: 'section', label: 'Availability', values: [null] });
    rows.push(sub('Gross borrowing base', result.borrowingBaseCents));
    if (result.facilityLimitCents !== null) {
      rows.push(acct('Less: capped at facility limit', -result.facilityCapAppliedCents));
    }
    rows.push(sub('Borrowing base', result.cappedBaseCents));
    rows.push(acct('Less: outstanding loan balance', -result.outstandingCents));
    rows.push({ kind: 'total', label: 'Net availability', values: [result.availabilityCents] });

    return {
      title: 'Borrowing Base Certificate',
      entityLabel,
      periodLabel: `As of ${data?.asOf ?? new Date().toISOString().slice(0, 10)}`,
      basisLabel: `AR ${(result.arAdvanceRate * 100).toFixed(0)}% · Inventory ${(result.inventoryAdvanceRate * 100).toFixed(0)}% · Cutoff ${result.agingCutoffDays}d · Concentration cap ${(result.concentrationCapPct * 100).toFixed(0)}%`,
      generatedAt: new Date().toISOString(),
      accent: '#10b981',
      columns: [{ key: 'amount', label: 'Amount', money: true }],
      rows,
    };
  };

  async function exportAs(fmt: 'pdf' | 'xlsx' | 'csv') {
    const model = buildModel();
    if (!model || busy) return;
    setBusy(fmt);
    try {
      if (fmt === 'csv') {
        const blob = new Blob([toCsv(model)], { type: 'text/csv;charset=utf-8' });
        downloadBlob(blob, buildExportFilename(model.title, 'csv'));
        addToast('success', 'CSV exported.');
        return;
      }
      const endpoint = fmt === 'xlsx' ? '/api/reports/export/xlsx' : '/api/reports/export/pdf';
      const resp = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(model),
      });
      if (!resp.ok) {
        let msg = `${fmt.toUpperCase()} export failed.`;
        try {
          const j = await resp.json();
          msg = j.error ?? msg;
        } catch {
          /* binary body */
        }
        throw new Error(msg);
      }
      const blob = await resp.blob();
      downloadBlob(blob, buildExportFilename(model.title, fmt));
      addToast('success', `${fmt === 'xlsx' ? 'Excel workbook' : 'PDF'} exported.`);
    } catch (err) {
      addToast('error', err instanceof Error ? err.message : 'Export failed.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-6">
      <Link href="/reports" className="inline-flex items-center gap-1.5 text-xs text-slate-500 hover:text-slate-300">
        <ArrowLeft size={14} /> Reports
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <PageHeader
          title="Borrowing base"
          description="Availability against eligible AR and inventory collateral, with standard advance rates and eligibility haircuts."
        />
        <div className="flex shrink-0 items-center gap-2">
          <button
            onClick={() => setForm(DEFAULT_FORM)}
            className="flex items-center gap-1.5 rounded-lg bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-300 hover:bg-slate-700"
          >
            <RotateCcw size={13} /> Reset
          </button>
          <ExportButton icon={<Sheet size={13} className="text-emerald-400" />} label="Excel" onClick={() => exportAs('xlsx')} busy={busy === 'xlsx'} disabled={!result} />
          <ExportButton icon={<TableIcon size={13} className="text-emerald-400" />} label="CSV" onClick={() => exportAs('csv')} busy={busy === 'csv'} disabled={!result} />
          <ExportButton icon={<FileText size={13} className="text-emerald-400" />} label="PDF" onClick={() => exportAs('pdf')} busy={busy === 'pdf'} disabled={!result} />
        </div>
      </div>

      {consolidated && (
        <div className="flex items-center gap-2 rounded-lg border border-indigo-500/30 bg-indigo-500/10 px-4 py-2.5 text-xs text-indigo-300">
          <Info size={14} /> Consolidated view — collateral is summed across all companies. Lenders usually certify per borrowing entity; pin a company for an entity-level certificate.
        </div>
      )}

      {data?.inventoryDegraded && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-2.5 text-xs text-amber-300">
          Inventory schema is pending — inventory collateral is treated as $0 until it is available.
        </div>
      )}

      {isLoading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-emerald-400" />
        </div>
      ) : error ? (
        <div className="p-8 text-center">
          <AlertCircle className="mx-auto mb-2 h-8 w-8 text-red-400" />
          <p className="text-sm text-red-400">{error}</p>
          <button onClick={() => refetch()} className="mt-3 rounded-lg bg-slate-800 px-3.5 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-700">
            Try again
          </button>
        </div>
      ) : !hasCollateral ? (
        <div className="card p-10 text-center">
          <Landmark className="mx-auto mb-3 h-8 w-8 text-slate-600" />
          <p className="text-sm text-slate-400">No eligible collateral to certify.</p>
          <p className="mx-auto mt-1 max-w-sm text-xs text-slate-600">
            There is no open accounts receivable and no on-hand inventory for {entityLabel}. Post invoices or receive
            inventory, then a borrowing base can be computed.
          </p>
        </div>
      ) : result ? (
        <div className="grid gap-6 lg:grid-cols-[300px_1fr]">
          {/* ── Adjustable inputs ── */}
          <aside className="space-y-4">
            <div className="card space-y-4 p-4">
              <h3 className="text-2xs font-semibold uppercase tracking-wider text-slate-500">Advance rates &amp; haircuts</h3>
              <PercentField label="AR advance rate" value={form.arAdvancePct} onChange={(v) => set('arAdvancePct', v)} />
              <PercentField label="Inventory advance rate" value={form.inventoryAdvancePct} onChange={(v) => set('inventoryAdvancePct', v)} />
              <NumberField label="AR aging cutoff (days)" value={form.agingCutoffDays} onChange={(v) => set('agingCutoffDays', v)} suffix="days" />
              <PercentField label="Concentration cap" value={form.concentrationCapPct} onChange={(v) => set('concentrationCapPct', v)} hint="0 disables the cap" />
              <label className="flex cursor-pointer items-start gap-2 text-xs text-slate-300">
                <input
                  type="checkbox"
                  checked={form.crossAgeTaint}
                  onChange={(e) => set('crossAgeTaint', e.target.checked)}
                  className="mt-0.5 accent-emerald-500"
                />
                <span>
                  Cross-age taint
                  <span className="mt-0.5 block text-[11px] text-slate-500">A customer with any past-due invoice becomes fully ineligible.</span>
                </span>
              </label>
            </div>

            <div className="card space-y-4 p-4">
              <h3 className="text-2xs font-semibold uppercase tracking-wider text-slate-500">Facility terms</h3>
              <MoneyField label="Inventory sublimit" value={form.inventorySublimitDollars} onChange={(v) => set('inventorySublimitDollars', v)} placeholder="No cap" />
              <MoneyField label="Facility / commitment limit" value={form.facilityLimitDollars} onChange={(v) => set('facilityLimitDollars', v)} placeholder="No limit" />
              <MoneyField label="Outstanding loan balance" value={form.outstandingDollars} onChange={(v) => set('outstandingDollars', v)} placeholder="0" />
            </div>
          </aside>

          {/* ── Certificate + concentration ── */}
          <div className="space-y-6">
            {/* Availability headline */}
            <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
              <Metric label="Borrowing base" value={formatMoney(result.cappedBaseCents)} />
              <Metric label="Outstanding" value={formatMoney(result.outstandingCents)} />
              <Metric label="Net availability" value={formatMoney(result.availabilityCents)} accent big />
              <Metric label="Utilization" value={utilization(result)} hint="Outstanding ÷ borrowing base" />
            </div>

            {result.concentrationFlag && result.topCustomer && (
              <div className="flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-2.5 text-xs text-amber-300">
                <AlertTriangle size={14} />
                Concentration risk: <span className="font-medium text-amber-200">{result.topCustomer.customerName}</span> is{' '}
                {(result.topCustomer.pctOfEligible * 100).toFixed(1)}% of eligible AR, above the{' '}
                {(result.concentrationCapPct * 100).toFixed(0)}% cap. The excess is already carved out above.
              </div>
            )}

            {/* Certificate */}
            <div className="card overflow-hidden">
              <div className="border-b border-slate-800 px-4 py-3">
                <p className="text-sm font-medium text-white">Borrowing base certificate</p>
                <p className="text-xs text-slate-500">
                  {entityLabel} · as of {data?.asOf} · {data?.arInvoiceCount ?? 0} open invoices · {data?.inventoryItemCount ?? 0} inventory items
                </p>
              </div>
              <table className="w-full text-sm tabular-nums">
                <tbody>
                  <CertSection title="Accounts receivable" />
                  <CertLine label="Gross accounts receivable" cents={result.grossArCents} />
                  <CertLine label={`Less: past due over ${result.agingCutoffDays} days`} cents={-result.arPastDueIneligibleCents} muted />
                  {result.crossAgeTaint && result.arCrossAgeIneligibleCents > 0 && (
                    <CertLine label="   incl. cross-age taint carve-out" cents={-result.arCrossAgeIneligibleCents} muted small />
                  )}
                  <CertLine label={`Less: concentration excess over ${(result.concentrationCapPct * 100).toFixed(0)}%`} cents={-result.arConcentrationIneligibleCents} muted />
                  <CertSubtotal label="Eligible accounts receivable" cents={result.eligibleArCents} />
                  <CertLine label={`AR availability @ ${(result.arAdvanceRate * 100).toFixed(1)}%`} cents={result.arAvailabilityCents} strong />

                  <CertSection title="Inventory" />
                  <CertLine label="On-hand inventory at cost" cents={result.inventoryValueCents} />
                  <CertLine label={`Advance @ ${(result.inventoryAdvanceRate * 100).toFixed(1)}%`} cents={result.inventoryUncappedAvailabilityCents} />
                  {result.inventorySublimitCents !== null && (
                    <CertLine label={`Less: inventory sublimit (${formatMoney(result.inventorySublimitCents)})`} cents={-result.inventorySublimitAppliedCents} muted />
                  )}
                  <CertSubtotal label="Inventory availability" cents={result.inventoryAvailabilityCents} />

                  <CertSection title="Availability" />
                  <CertSubtotal label="Gross borrowing base" cents={result.borrowingBaseCents} />
                  {result.facilityLimitCents !== null && (
                    <CertLine label={`Less: capped at facility limit (${formatMoney(result.facilityLimitCents)})`} cents={-result.facilityCapAppliedCents} muted />
                  )}
                  <CertSubtotal label="Borrowing base" cents={result.cappedBaseCents} />
                  <CertLine label="Less: outstanding loan balance" cents={-result.outstandingCents} muted />
                </tbody>
                <tfoot>
                  <tr className="border-t-2 border-slate-700 bg-surface-950/40">
                    <td className="px-4 py-3 text-sm font-semibold text-white">Net availability</td>
                    <td className="px-4 py-3 text-right font-mono text-lg font-semibold text-emerald-400">{formatMoney(result.availabilityCents)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>

            {/* Concentration table */}
            {result.customers.length > 0 && (
              <div className="card overflow-hidden">
                <div className="border-b border-slate-800 px-4 py-3">
                  <p className="text-sm font-medium text-white">Customer concentration</p>
                  <p className="text-xs text-slate-500">Eligible AR by customer, after past-due and concentration carve-outs.</p>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[640px] text-sm tabular-nums">
                    <thead>
                      <tr className="border-b border-slate-800 text-left text-2xs uppercase text-slate-500">
                        <th className="px-4 py-2 font-medium">Customer</th>
                        <th className="px-4 py-2 text-right font-medium">Gross AR</th>
                        <th className="px-4 py-2 text-right font-medium">Ineligible</th>
                        <th className="px-4 py-2 text-right font-medium">Eligible</th>
                        <th className="px-4 py-2 text-right font-medium">% of eligible</th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.customers.map((c) => {
                        const ineligible = c.pastDueIneligibleCents + c.concentrationExcessCents;
                        const over = result.concentrationCapPct > 0 && c.pctOfEligible > result.concentrationCapPct + 1e-9;
                        return (
                          <tr key={c.customerId} className="border-b border-slate-800/60 hover:bg-slate-800/30">
                            <td className="px-4 py-2.5 text-white">
                              {c.customerName}
                              {c.hasPastDue && <span className="ml-2 text-[10px] uppercase text-red-400">past due</span>}
                            </td>
                            <td className="px-4 py-2.5 text-right font-mono text-slate-300">{formatMoney(c.totalCents)}</td>
                            <td className={clsx('px-4 py-2.5 text-right font-mono', ineligible > 0 ? 'text-amber-400' : 'text-slate-600')}>
                              {ineligible > 0 ? formatMoney(ineligible) : '—'}
                            </td>
                            <td className="px-4 py-2.5 text-right font-mono text-white">{formatMoney(c.eligibleCents)}</td>
                            <td className={clsx('px-4 py-2.5 text-right font-mono', over ? 'text-amber-400' : 'text-slate-400')}>
                              {(c.pctOfEligible * 100).toFixed(1)}%
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                    <tfoot>
                      <tr className="border-t border-slate-800 bg-surface-950/40">
                        <td className="px-4 py-2.5 text-xs uppercase text-slate-500">Eligible AR</td>
                        <td className="px-4 py-2.5 text-right font-mono text-slate-500">{formatMoney(result.grossArCents)}</td>
                        <td className="px-4 py-2.5 text-right font-mono text-amber-400">
                          {formatMoney(result.arPastDueIneligibleCents + result.arConcentrationIneligibleCents)}
                        </td>
                        <td className="px-4 py-2.5 text-right font-mono font-semibold text-white">{formatMoney(result.eligibleArCents)}</td>
                        <td className="px-4 py-2.5 text-right font-mono text-slate-500">100%</td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              </div>
            )}

            <p className="text-xs text-slate-600">
              Deterministic calculation (no AI). Figures are carried from the AR-aging view and the inventory-valuation
              engine in bigint cents. Foreign / affiliate ineligibles are not modelled — the customer record carries no
              reliable flag for them. Generated {data ? new Date(data.generatedAt).toLocaleString() : ''}.
            </p>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function utilization(r: BorrowingBaseResult): string {
  if (r.cappedBaseCents <= 0) return '—';
  return `${((r.outstandingCents / r.cappedBaseCents) * 100).toFixed(0)}%`;
}

// ── Presentational helpers ─────────────────────────────────────────────────────

function ExportButton({
  icon, label, onClick, busy, disabled,
}: { icon: ReactNode; label: string; onClick: () => void; busy: boolean; disabled: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled || busy}
      className="flex items-center gap-1.5 rounded-lg bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-700 disabled:opacity-40"
    >
      {busy ? <Loader2 size={13} className="animate-spin" /> : icon}
      {label}
    </button>
  );
}

function Metric({ label, value, accent, big, hint }: { label: string; value: string; accent?: boolean; big?: boolean; hint?: string }) {
  return (
    <div className="card p-4">
      <span className="text-2xs uppercase text-slate-500">{label}</span>
      <p className={clsx('mt-1 font-mono font-semibold tabular-nums', big ? 'text-2xl' : 'text-xl', accent ? 'text-emerald-400' : 'text-white')}>{value}</p>
      {hint && <p className="mt-0.5 text-[11px] text-slate-600">{hint}</p>}
    </div>
  );
}

function fieldWrap(label: string, hint: string | undefined, control: ReactNode) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs text-slate-400">{label}</span>
      {control}
      {hint && <span className="mt-0.5 block text-[11px] text-slate-600">{hint}</span>}
    </label>
  );
}

function PercentField({ label, value, onChange, hint }: { label: string; value: string; onChange: (v: string) => void; hint?: string }) {
  return fieldWrap(label, hint, (
    <div className="flex items-center rounded-lg border border-slate-700 bg-surface-950 focus-within:border-emerald-500/50">
      <input
        type="number"
        inputMode="decimal"
        min={0}
        max={100}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full bg-transparent px-3 py-1.5 text-sm tabular-nums text-white outline-none"
      />
      <span className="px-3 text-xs text-slate-500">%</span>
    </div>
  ));
}

function NumberField({ label, value, onChange, suffix }: { label: string; value: string; onChange: (v: string) => void; suffix?: string }) {
  return fieldWrap(label, undefined, (
    <div className="flex items-center rounded-lg border border-slate-700 bg-surface-950 focus-within:border-emerald-500/50">
      <input
        type="number"
        inputMode="numeric"
        min={0}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full bg-transparent px-3 py-1.5 text-sm tabular-nums text-white outline-none"
      />
      {suffix && <span className="px-3 text-xs text-slate-500">{suffix}</span>}
    </div>
  ));
}

function MoneyField({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string }) {
  return fieldWrap(label, undefined, (
    <div className="flex items-center rounded-lg border border-slate-700 bg-surface-950 focus-within:border-emerald-500/50">
      <span className="pl-3 text-xs text-slate-500">$</span>
      <input
        type="text"
        inputMode="decimal"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="w-full bg-transparent px-2 py-1.5 text-sm tabular-nums text-white outline-none placeholder:text-slate-600"
      />
    </div>
  ));
}

function CertSection({ title }: { title: string }) {
  return (
    <tr className="bg-slate-800/30">
      <td className="px-4 py-2 text-2xs font-semibold uppercase tracking-wider text-slate-400">{title}</td>
      <td className="px-4 py-2" />
    </tr>
  );
}

function CertLine({ label, cents, muted, strong, small }: { label: string; cents: number; muted?: boolean; strong?: boolean; small?: boolean }) {
  return (
    <tr className="border-b border-slate-800/50">
      <td className={clsx('px-4 py-2 pl-8', small ? 'text-xs' : 'text-sm', muted ? 'text-slate-500' : strong ? 'font-medium text-white' : 'text-slate-300')}>
        {label}
      </td>
      <td className={clsx('px-4 py-2 text-right font-mono tabular-nums', small ? 'text-xs' : 'text-sm', muted ? 'text-slate-500' : strong ? 'font-medium text-emerald-400' : 'text-slate-200')}>
        {formatMoney(cents)}
      </td>
    </tr>
  );
}

function CertSubtotal({ label, cents }: { label: string; cents: number }) {
  return (
    <tr className="border-t border-slate-800 bg-surface-950/30">
      <td className="px-4 py-2 text-sm font-semibold text-white">{label}</td>
      <td className="px-4 py-2 text-right font-mono text-sm font-semibold tabular-nums text-white">{formatMoney(cents)}</td>
    </tr>
  );
}
