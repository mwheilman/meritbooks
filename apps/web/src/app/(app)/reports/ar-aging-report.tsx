'use client';

import { useMemo, useState, useCallback } from 'react';
import { useQuery } from '@/hooks';
import { formatMoney } from '@meritbooks/shared';
import { Loader2, AlertCircle, ChevronRight, Inbox } from 'lucide-react';
import { clsx } from 'clsx';
import {
  mergeArAging,
  AR_BUCKET_ORDER,
  type ArBucketKey,
  type BilledInvoiceLine,
  type UnbilledJobRow,
  type MergedCustomer,
} from '@/lib/reports/ar-aging-merge';

// ── Wire types: the exact shape the /api/reports/ar-aging route returns. ──
interface ArAgingRow {
  customerName: string;
  invoiceNumber: string;
  invoiceDate: string;
  dueDate: string;
  totalCents: number;
  paidCents: number;
  balanceCents: number;
  agingBucket: string;
  locationName: string;
}

interface UnbilledSection {
  rows: UnbilledJobRow[];
  buckets: Record<string, number>;
  totalCents: number;
  hasAttribution: boolean;
}

interface ArAgingData {
  data: ArAgingRow[];
  buckets: Record<string, { count: number; totalCents: number }>;
  totalOutstanding: number;
  unbilled?: UnbilledSection;
  asOf?: string;
  totalReceivablesCents?: number;
}

const BUCKET_COLORS: Record<ArBucketKey, string> = {
  CURRENT: 'bg-emerald-500', '1-30': 'bg-blue-500', '31-60': 'bg-amber-500', '61-90': 'bg-orange-500', '90+': 'bg-red-500',
};
const BUCKET_TEXT: Record<ArBucketKey, string> = {
  CURRENT: 'text-emerald-400', '1-30': 'text-blue-400', '31-60': 'text-amber-400', '61-90': 'text-orange-400', '90+': 'text-red-400',
};
const bucketLabel = (b: ArBucketKey) => (b === 'CURRENT' ? 'Current' : `${b} days`);

// One shared money-cell renderer so parent/child/detail rows align identically.
function BucketCells({ buckets, muted }: { buckets: Record<ArBucketKey, number>; muted?: boolean }) {
  return (
    <>
      {AR_BUCKET_ORDER.map((b) => {
        const v = buckets[b] ?? 0;
        return (
          <td key={b} className={clsx('px-3 py-2 text-right text-xs font-mono tabular-nums', v !== 0 ? (muted ? 'text-slate-400' : BUCKET_TEXT[b]) : 'text-slate-700')}>
            {v !== 0 ? formatMoney(v) : '—'}
          </td>
        );
      })}
    </>
  );
}

export function ArAgingReport({ params }: { params: Record<string, string> }) {
  const clean = Object.fromEntries(Object.entries(params).filter(([, v]) => v));
  const qs = new URLSearchParams(clean).toString();
  const { data, isLoading, error } = useQuery<ArAgingData>(`/api/reports/ar-aging${qs ? '?' + qs : ''}`);

  // ── Expansion state: each level independent, plus a global split toggle. ──
  const [expandedCustomers, setExpandedCustomers] = useState<Set<string>>(new Set());
  const [expandedChildren, setExpandedChildren] = useState<Set<string>>(new Set());
  const [splitAll, setSplitAll] = useState(false);

  const toggleCustomer = useCallback((name: string) => {
    setExpandedCustomers((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }, []);
  const toggleChild = useCallback((key: string) => {
    setExpandedChildren((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  // ── Merge billed invoice lines + unbilled job rows into ONE combined model. ──
  const merged = useMemo(() => {
    if (!data) return null;
    const billed: BilledInvoiceLine[] = (data.data ?? []).map((r) => ({
      customerName: r.customerName,
      invoiceNumber: r.invoiceNumber,
      invoiceDate: r.invoiceDate,
      dueDate: r.dueDate,
      agingBucket: r.agingBucket,
      balanceCents: r.balanceCents,
      locationName: r.locationName,
    }));
    const unbilledRows: UnbilledJobRow[] = data.unbilled?.rows ?? [];
    return mergeArAging(billed, unbilledRows);
  }, [data]);

  if (isLoading) return <div className="card p-12 flex items-center justify-center"><Loader2 size={24} className="animate-spin text-slate-500" /></div>;
  if (error) return <div className="card p-8 text-center"><AlertCircle size={24} className="mx-auto text-red-400 mb-2" /><p className="text-sm text-red-400">{String(error)}</p></div>;
  if (!data || !merged || merged.customers.length === 0) {
    return (
      <div className="card p-8 flex flex-col items-center justify-center text-center">
        <div className="h-12 w-12 rounded-xl bg-slate-800 flex items-center justify-center mb-3">
          <Inbox size={22} className="text-slate-500" />
        </div>
        <p className="text-sm text-slate-400">No outstanding receivables.</p>
      </div>
    );
  }

  const { customers, combinedTotals, combinedTotalCents, billedTotals, billedTotalCents, unbilledTotals, unbilledTotalCents } = merged;
  const totalForBar = Math.max(combinedTotalCents, 1);
  const anyUnbilled = unbilledTotalCents !== 0;

  const isCustomerOpen = (name: string) => splitAll || expandedCustomers.has(name);

  const toggleSplitAll = () => {
    setSplitAll((prev) => {
      // Turning the global toggle off also collapses any per-row expansions so the
      // report returns cleanly to the single-number parent view.
      if (prev) { setExpandedCustomers(new Set()); setExpandedChildren(new Set()); }
      return !prev;
    });
  };

  return (
    <div className="space-y-4">
      {/* ─── Summary: ONE headline AR number + combined bucket strip ─── */}
      <div className="card p-5">
        <div className="flex items-center justify-between mb-3">
          <p className="text-sm font-medium text-white">
            Total Receivables: <span className="font-mono text-emerald-400 tabular-nums">{formatMoney(combinedTotalCents)}</span>
          </p>
          <p className="text-xs text-slate-500">
            {customers.length} customer{customers.length === 1 ? '' : 's'}
            {data.asOf ? ` · as of ${data.asOf}` : ''}
          </p>
        </div>
        <div className="h-3 rounded-full overflow-hidden flex bg-slate-800 mb-3">
          {AR_BUCKET_ORDER.map((b) => {
            const v = combinedTotals[b];
            if (!v) return null;
            return <div key={b} className={clsx('h-full', BUCKET_COLORS[b])} style={{ width: `${(v / totalForBar) * 100}%` }} />;
          })}
        </div>
        <div className="flex items-center gap-6">
          {AR_BUCKET_ORDER.map((b) => (
            <div key={b} className="text-center">
              <p className={clsx('text-xs font-medium', BUCKET_TEXT[b])}>{bucketLabel(b)}</p>
              <p className="text-sm font-mono text-white tabular-nums">{formatMoney(combinedTotals[b])}</p>
            </div>
          ))}
        </div>
        {anyUnbilled && (
          <p className="mt-3 text-[11px] text-slate-500">
            Includes <span className="text-indigo-400">{formatMoney(unbilledTotalCents)}</span> unbilled receivable (contract asset, acct 1180).
            Expand a customer to see billed vs unbilled.
          </p>
        )}
      </div>

      {/* ─── Unified, collapsible AR aging table ─── */}
      <div className="card overflow-hidden">
        <div className="px-4 py-2.5 border-b border-slate-800 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-white">AR Aging</h3>
          <button
            type="button"
            onClick={toggleSplitAll}
            aria-pressed={splitAll}
            className={clsx(
              'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-emerald-500/40',
              splitAll ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/30' : 'bg-slate-800 text-slate-300 border border-slate-700 hover:border-slate-600',
            )}
          >
            <ChevronRight size={12} className={clsx('transition-transform', splitAll && 'rotate-90')} />
            {splitAll ? 'Collapse all' : 'Show billed vs unbilled'}
          </button>
        </div>
        <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <caption className="sr-only">
            Accounts receivable aging — billed trade AR and unbilled contract asset combined per customer, expandable to the billed vs unbilled split.
          </caption>
          <thead>
            <tr className="border-b border-slate-800">
              <th scope="col" className="px-4 py-2.5 text-left text-2xs font-semibold uppercase text-slate-500">Customer</th>
              {AR_BUCKET_ORDER.map((b) => (
                <th key={b} scope="col" className={clsx('px-3 py-2.5 text-right text-2xs font-semibold uppercase w-24', BUCKET_TEXT[b])}>
                  {b === 'CURRENT' ? 'Current' : b}
                </th>
              ))}
              <th scope="col" className="px-4 py-2.5 text-right text-2xs font-semibold uppercase text-slate-500 w-28">Balance</th>
            </tr>
          </thead>
          <tbody>
            {customers.map((c) => (
              <CustomerRows
                key={c.customerName}
                customer={c}
                open={isCustomerOpen(c.customerName)}
                onToggle={() => toggleCustomer(c.customerName)}
                childOpen={expandedChildren}
                onToggleChild={toggleChild}
              />
            ))}
          </tbody>
          <tfoot>
            {/* When split, show the two subtotals so the reader sees the combined
                total decompose into billed + unbilled and ties out. */}
            {splitAll && (
              <>
                <tr className="border-t border-slate-800 bg-slate-900/40">
                  <td className="px-4 py-2 pl-8 text-xs text-slate-400">Total Billed</td>
                  <BucketCells buckets={billedTotals} muted />
                  <td className="px-4 py-2 text-right text-xs font-mono tabular-nums text-slate-300">{formatMoney(billedTotalCents)}</td>
                </tr>
                <tr className="bg-slate-900/40">
                  <td className="px-4 py-2 pl-8 text-xs text-indigo-300">Total Unbilled (contract asset)</td>
                  <BucketCells buckets={unbilledTotals} muted />
                  <td className="px-4 py-2 text-right text-xs font-mono tabular-nums text-slate-300">{formatMoney(unbilledTotalCents)}</td>
                </tr>
              </>
            )}
            <tr className="border-t-2 border-slate-700 bg-slate-800/40">
              <td className="px-4 py-2.5 text-sm font-semibold text-white">Total Receivables</td>
              {AR_BUCKET_ORDER.map((b) => (
                <td key={b} className={clsx('px-3 py-2.5 text-right text-xs font-mono tabular-nums font-semibold', BUCKET_TEXT[b])}>{formatMoney(combinedTotals[b])}</td>
              ))}
              <td className="px-4 py-2.5 text-right text-sm font-mono tabular-nums font-bold text-white">{formatMoney(combinedTotalCents)}</td>
            </tr>
          </tfoot>
        </table>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// ONE CUSTOMER: combined parent row + (when expanded) billed/unbilled children,
// each further expandable to invoices / jobs.
// ═══════════════════════════════════════════════════════════════

function CustomerRows({ customer, open, onToggle, childOpen, onToggleChild }: {
  customer: MergedCustomer;
  open: boolean;
  onToggle: () => void;
  childOpen: Set<string>;
  onToggleChild: (key: string) => void;
}) {
  const { customerName, buckets, totalCents, billed, unbilled, hasBilled, hasUnbilled } = customer;
  const billedKey = `${customerName}::billed`;
  const unbilledKey = `${customerName}::unbilled`;
  const billedDetailOpen = childOpen.has(billedKey);
  const unbilledDetailOpen = childOpen.has(unbilledKey);

  return (
    <>
      {/* Parent: combined billed + unbilled */}
      <tr className="bg-slate-800/30 border-b border-slate-800/40">
        <td className="px-4 py-2">
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={open}
            className="inline-flex items-center gap-1.5 text-xs font-semibold text-white hover:text-emerald-400 transition-colors focus:outline-none focus:ring-2 focus:ring-emerald-500/40 rounded"
          >
            <ChevronRight size={13} className={clsx('text-slate-500 transition-transform', open && 'rotate-90')} />
            {customerName}
          </button>
        </td>
        <BucketCells buckets={buckets} />
        <td className="px-4 py-2 text-right text-xs font-mono tabular-nums font-semibold text-white">{formatMoney(totalCents)}</td>
      </tr>

      {open && (
        <>
          {/* Billed child */}
          <tr className="hover:bg-slate-800/20 border-b border-slate-800/20">
            <td className="px-4 py-1.5 pl-8">
              {hasBilled && billed.lines.length > 0 ? (
                <button
                  type="button"
                  onClick={() => onToggleChild(billedKey)}
                  aria-expanded={billedDetailOpen}
                  className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-300 hover:text-white transition-colors focus:outline-none focus:ring-2 focus:ring-emerald-500/40 rounded"
                >
                  <ChevronRight size={12} className={clsx('text-slate-600 transition-transform', billedDetailOpen && 'rotate-90')} />
                  Billed
                  <span className="text-slate-600">· {billed.lines.length} invoice{billed.lines.length === 1 ? '' : 's'}</span>
                </button>
              ) : (
                <span className="inline-flex items-center gap-1.5 pl-[18px] text-xs font-medium text-slate-500">Billed</span>
              )}
            </td>
            <BucketCells buckets={billed.buckets} muted />
            <td className="px-4 py-1.5 text-right text-xs font-mono tabular-nums text-slate-300">{formatMoney(billed.totalCents)}</td>
          </tr>
          {billedDetailOpen && billed.lines.map((line, i) => (
            <tr key={`${billedKey}-${line.invoiceNumber || 'inv'}-${i}`} className="hover:bg-slate-800/10 border-b border-slate-800/10">
              <td className="px-4 py-1 pl-14 text-2xs">
                <span className="font-mono text-slate-400">{line.invoiceNumber || '—'}</span>
                <span className="text-slate-600"> · {line.locationName} · due {line.dueDate}</span>
              </td>
              {AR_BUCKET_ORDER.map((b) => (
                <td key={b} className="px-3 py-1 text-right text-2xs font-mono tabular-nums text-slate-500">
                  {line.agingBucket === b ? formatMoney(line.balanceCents) : ''}
                </td>
              ))}
              <td className="px-4 py-1 text-right text-2xs font-mono tabular-nums text-slate-400">{formatMoney(line.balanceCents)}</td>
            </tr>
          ))}

          {/* Unbilled child */}
          <tr className="hover:bg-slate-800/20 border-b border-slate-800/20">
            <td className="px-4 py-1.5 pl-8">
              {hasUnbilled && unbilled.jobs.length > 0 ? (
                <button
                  type="button"
                  onClick={() => onToggleChild(unbilledKey)}
                  aria-expanded={unbilledDetailOpen}
                  className="inline-flex items-center gap-1.5 text-xs font-medium text-indigo-300 hover:text-indigo-200 transition-colors focus:outline-none focus:ring-2 focus:ring-emerald-500/40 rounded"
                >
                  <ChevronRight size={12} className={clsx('text-slate-600 transition-transform', unbilledDetailOpen && 'rotate-90')} />
                  Unbilled
                  <span className="px-1 py-0.5 text-[9px] rounded bg-indigo-500/10 text-indigo-400">Acct 1180</span>
                  <span className="text-slate-600">· {unbilled.jobs.length} job{unbilled.jobs.length === 1 ? '' : 's'}</span>
                </button>
              ) : (
                <span className="inline-flex items-center gap-1.5 pl-[18px] text-xs font-medium text-slate-500">
                  Unbilled <span className="px-1 py-0.5 text-[9px] rounded bg-indigo-500/10 text-indigo-400">Acct 1180</span>
                </span>
              )}
            </td>
            <BucketCells buckets={unbilled.buckets} muted />
            <td className="px-4 py-1.5 text-right text-xs font-mono tabular-nums text-slate-300">{formatMoney(unbilled.totalCents)}</td>
          </tr>
          {unbilledDetailOpen && unbilled.jobs.map((job, i) => (
            <tr key={`${unbilledKey}-${job.jobLabel ?? 'job'}-${i}`} className="hover:bg-slate-800/10 border-b border-slate-800/10">
              <td className="px-4 py-1 pl-14 text-2xs text-slate-500">{job.jobLabel ?? 'Unattributed'}</td>
              {AR_BUCKET_ORDER.map((b) => {
                const v = job.buckets[b] ?? 0;
                return (
                  <td key={b} className="px-3 py-1 text-right text-2xs font-mono tabular-nums text-slate-500">
                    {v !== 0 ? formatMoney(v) : ''}
                  </td>
                );
              })}
              <td className="px-4 py-1 text-right text-2xs font-mono tabular-nums text-slate-400">{formatMoney(job.totalCents)}</td>
            </tr>
          ))}
        </>
      )}
    </>
  );
}
