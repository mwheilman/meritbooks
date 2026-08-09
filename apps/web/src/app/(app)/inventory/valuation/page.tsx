'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import {
  ArrowLeft,
  Loader2,
  AlertCircle,
  Package,
  Download,
  Scale,
  CheckCircle2,
  AlertTriangle,
} from 'lucide-react';
import { clsx } from 'clsx';
import { useQuery } from '@/hooks';
import { formatMoney } from '@meritbooks/shared';
import { PageHeader } from '@/components/ui';
import { CompanyScopeGuard } from '@/components/company-scope-guard';

interface ReportLine {
  id: string;
  sku: string;
  name: string;
  uom: string;
  valuationMethod: 'WEIGHTED_AVG' | 'FIFO';
  qtyOnHand: number;
  avgCostCents: number;
  valueCents: number;
  pctOfTotal: number;
  isActive: boolean;
}
interface ReportGroup {
  locationId: string | null;
  locationName: string;
  lines: ReportLine[];
  itemCount: number;
  totalValueCents: number;
}
interface MethodBreakdown {
  method: 'WEIGHTED_AVG' | 'FIFO';
  itemCount: number;
  totalValueCents: number;
}
interface ValuationReportResponse {
  report: {
    groups: ReportGroup[];
    summary: { itemCount: number; itemsOnHand: number; totalValueCents: number; byMethod: MethodBreakdown[] };
  };
  tieOut: { subledgerCents: number; glCents: number; varianceCents: number; inSync: boolean; resolvable: boolean };
  cogs: { realizedCents: number; movementCount: number; from: string | null; to: string | null };
  generatedAt: string;
  degraded?: boolean;
}

const METHOD_LABEL: Record<string, string> = { WEIGHTED_AVG: 'Wtd Avg', FIFO: 'FIFO' };

export default function InventoryValuationPage() {
  return (
    <CompanyScopeGuard>
      <InventoryValuationInner />
    </CompanyScopeGuard>
  );
}

function InventoryValuationInner() {
  const [includeZero, setIncludeZero] = useState(false);
  const { data, isLoading, error, refetch } = useQuery<ValuationReportResponse>(
    `/api/inventory/valuation-report${includeZero ? '?include_zero=1' : ''}`,
    { key: includeZero ? 'z1' : 'z0' },
  );

  const report = data?.report;
  const tie = data?.tieOut;
  const groups = report?.groups ?? [];

  const exportCsv = useMemo(
    () => () => {
      if (!report) return;
      const rows: string[][] = [['Location', 'SKU', 'Item', 'Method', 'On hand', 'UoM', 'Avg cost', 'Value', '% of total']];
      for (const g of report.groups) {
        for (const l of g.lines) {
          rows.push([
            g.locationName,
            l.sku,
            l.name,
            METHOD_LABEL[l.valuationMethod],
            String(l.qtyOnHand),
            l.uom,
            (l.avgCostCents / 100).toFixed(2),
            (l.valueCents / 100).toFixed(2),
            (l.pctOfTotal * 100).toFixed(1) + '%',
          ]);
        }
      }
      rows.push(['', '', '', '', '', '', '', (report.summary.totalValueCents / 100).toFixed(2), 'TOTAL']);
      const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
      const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `stock-valuation-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    },
    [report],
  );

  return (
    <div className="space-y-6">
      <Link href="/inventory" className="inline-flex items-center gap-1.5 text-xs text-slate-500 hover:text-slate-300">
        <ArrowLeft size={14} /> Inventory
      </Link>

      <div className="flex items-start justify-between gap-3">
        <PageHeader title="Stock valuation" description="On-hand inventory value by item and location, reconciled to the general ledger." />
        <button
          onClick={exportCsv}
          disabled={!report || report.summary.itemCount === 0}
          className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 bg-slate-800 hover:bg-slate-700 disabled:opacity-40 rounded-lg text-xs font-medium text-slate-200"
        >
          <Download size={14} /> Export CSV
        </button>
      </div>

      {data?.degraded && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-2.5 text-xs text-amber-300">
          Inventory schema is pending. The report will populate once the migration is applied.
        </div>
      )}

      {isLoading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="w-6 h-6 text-emerald-400 animate-spin" />
        </div>
      ) : error ? (
        <div className="p-8 text-center">
          <AlertCircle className="w-8 h-8 mx-auto text-red-400 mb-2" />
          <p className="text-red-400 text-sm">{error}</p>
          <button onClick={() => refetch()} className="mt-3 rounded-lg bg-slate-800 px-3.5 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-700">
            Try again
          </button>
        </div>
      ) : (
        <>
          {/* Summary cards */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <Metric label="On-hand value" value={formatMoney(report?.summary.totalValueCents ?? 0)} accent />
            <Metric label="Items on hand" value={String(report?.summary.itemsOnHand ?? 0)} />
            <Metric
              label="COGS realized"
              value={formatMoney(data?.cogs.realizedCents ?? 0)}
              hint={`${data?.cogs.movementCount ?? 0} posted issues/adjustments`}
            />
            <TieOutCard tie={tie} />
          </div>

          {/* Method breakdown */}
          {(report?.summary.byMethod.length ?? 0) > 0 && (
            <div className="flex flex-wrap gap-2">
              {report!.summary.byMethod.map((m) => (
                <div key={m.method} className="flex items-center gap-2 rounded-lg border border-slate-800 bg-surface-900 px-3 py-1.5 text-xs">
                  <Scale size={13} className="text-slate-500" />
                  <span className="text-slate-400">{METHOD_LABEL[m.method]}</span>
                  <span className="font-mono text-white">{formatMoney(m.totalValueCents)}</span>
                  <span className="text-slate-600">· {m.itemCount} item{m.itemCount === 1 ? '' : 's'}</span>
                </div>
              ))}
              <label className="ml-auto flex items-center gap-2 text-xs text-slate-400 cursor-pointer">
                <input type="checkbox" checked={includeZero} onChange={(e) => setIncludeZero(e.target.checked)} className="accent-emerald-500" />
                Show zero-quantity items
              </label>
            </div>
          )}

          {/* Grouped table */}
          {groups.length === 0 ? (
            <div className="card p-10 text-center">
              <Package className="w-8 h-8 mx-auto text-slate-600 mb-3" />
              <p className="text-slate-400 text-sm">No on-hand inventory to value.</p>
              <Link href="/inventory" className="mt-3 inline-block text-emerald-400 text-sm hover:text-emerald-300">
                Go to inventory
              </Link>
            </div>
          ) : (
            <div className="space-y-6">
              {groups.map((g) => (
                <div key={g.locationId ?? 'unassigned'} className="card overflow-hidden">
                  <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800">
                    <div className="text-sm font-medium text-white">{g.locationName}</div>
                    <div className="text-xs text-slate-500">
                      {g.itemCount} item{g.itemCount === 1 ? '' : 's'} ·{' '}
                      <span className="font-mono text-slate-300">{formatMoney(g.totalValueCents)}</span>
                    </div>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm min-w-[720px]">
                      <thead>
                        <tr className="border-b border-slate-800 text-left text-xs uppercase text-slate-500">
                          <th className="px-4 py-2 font-medium">SKU</th>
                          <th className="px-4 py-2 font-medium">Item</th>
                          <th className="px-4 py-2 font-medium">Method</th>
                          <th className="px-4 py-2 font-medium text-right">On hand</th>
                          <th className="px-4 py-2 font-medium text-right">Avg cost</th>
                          <th className="px-4 py-2 font-medium text-right">Value</th>
                          <th className="px-4 py-2 font-medium text-right">% of total</th>
                        </tr>
                      </thead>
                      <tbody>
                        {g.lines.map((l) => (
                          <tr key={l.id} className="border-b border-slate-800/60 hover:bg-slate-800/30">
                            <td className="px-4 py-2.5 font-mono text-xs text-slate-300">{l.sku}</td>
                            <td className="px-4 py-2.5 text-white">
                              <Link href={`/inventory/${l.id}`} className="hover:text-emerald-400">{l.name}</Link>
                              {!l.isActive && <span className="ml-2 text-xs text-slate-600">(inactive)</span>}
                            </td>
                            <td className="px-4 py-2.5 text-xs text-slate-400">{METHOD_LABEL[l.valuationMethod]}</td>
                            <td className="px-4 py-2.5 text-right font-mono text-slate-200">
                              {l.qtyOnHand} <span className="text-slate-600">{l.uom}</span>
                            </td>
                            <td className="px-4 py-2.5 text-right font-mono text-slate-300">{formatMoney(l.avgCostCents)}</td>
                            <td className="px-4 py-2.5 text-right font-mono text-white">{formatMoney(l.valueCents)}</td>
                            <td className="px-4 py-2.5 text-right font-mono text-slate-400">{(l.pctOfTotal * 100).toFixed(1)}%</td>
                          </tr>
                        ))}
                      </tbody>
                      <tfoot>
                        <tr className="border-t border-slate-800 bg-surface-950/40">
                          <td colSpan={5} className="px-4 py-2.5 text-xs uppercase text-slate-500">Subtotal</td>
                          <td className="px-4 py-2.5 text-right font-mono text-white">{formatMoney(g.totalValueCents)}</td>
                          <td />
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                </div>
              ))}

              {/* Grand total */}
              <div className="card flex items-center justify-between px-4 py-3">
                <span className="text-sm font-medium text-white">Total inventory value</span>
                <span className="font-mono text-lg font-semibold text-emerald-400">{formatMoney(report?.summary.totalValueCents ?? 0)}</span>
              </div>
            </div>
          )}

          {data?.generatedAt && (
            <p className="text-xs text-slate-600">
              Current on-hand valuation, generated {new Date(data.generatedAt).toLocaleString()}. Values are carried from each
              item&apos;s valuation ledger (bigint cents), not re-multiplied from quantity.
            </p>
          )}
        </>
      )}
    </div>
  );
}

function TieOutCard({ tie }: { tie: ValuationReportResponse['tieOut'] | undefined }) {
  if (!tie || !tie.resolvable) {
    return (
      <div className="card p-4">
        <span className="text-xs text-slate-500 uppercase">GL tie-out</span>
        <p className="text-sm text-slate-400 mt-1">No inventory asset account mapped.</p>
      </div>
    );
  }
  const inSync = tie.inSync;
  return (
    <div className={clsx('card p-4 border', inSync ? 'border-emerald-500/30' : 'border-amber-500/30')}>
      <div className="flex items-center gap-1.5">
        {inSync ? <CheckCircle2 size={13} className="text-emerald-400" /> : <AlertTriangle size={13} className="text-amber-400" />}
        <span className="text-xs text-slate-500 uppercase">GL tie-out</span>
      </div>
      {inSync ? (
        <p className="text-sm font-medium text-emerald-400 mt-1">Ties to GL 1200</p>
      ) : (
        <>
          <p className={clsx('text-lg font-mono font-semibold mt-1', 'text-amber-400')}>{formatMoney(tie.varianceCents)}</p>
          <p className="text-[11px] text-slate-500 mt-0.5">
            Subledger {formatMoney(tie.subledgerCents)} vs GL {formatMoney(tie.glCents)}
          </p>
        </>
      )}
    </div>
  );
}

function Metric({ label, value, accent, hint }: { label: string; value: string; accent?: boolean; hint?: string }) {
  return (
    <div className="card p-4">
      <span className="text-xs text-slate-500 uppercase">{label}</span>
      <p className={clsx('text-xl font-mono font-semibold mt-1', accent ? 'text-emerald-400' : 'text-white')}>{value}</p>
      {hint && <p className="text-[11px] text-slate-600 mt-0.5">{hint}</p>}
    </div>
  );
}
