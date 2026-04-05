'use client';

import { useState } from 'react';
import { Check, Flag, Pencil, Receipt, FileText, Link2 } from 'lucide-react';
import { clsx } from 'clsx';
import { StatusBadge, ConfidenceBar } from '@/components/ui';
import { formatMoney } from '@meritbooks/shared';

interface BankTxn {
  id: string;
  date: string;
  description: string;
  amountCents: number;
  status: string;
  locationName: string;
  locationCode: string;
  aiAccountName: string | null;
  aiVendorName: string | null;
  aiConfidence: number | null;
  matchType: string | null;
  matchLabel: string | null;
}

// Demo data
const DEMO_TXNS: BankTxn[] = [
  { id: '1', date: '2026-04-03', description: 'MENARDS AMES IA #3344', amountCents: -34218, status: 'CATEGORIZED', locationName: 'Swan Creek Construction', locationCode: 'SCC', aiAccountName: '5100 · Materials', aiVendorName: 'Menards', aiConfidence: 0.94, matchType: 'VENDOR_PATTERN', matchLabel: 'Vendor Match' },
  { id: '2', date: '2026-04-03', description: 'CARRIER HVAC PAYMENT', amountCents: -824000, status: 'CATEGORIZED', locationName: 'Heartland HVAC', locationCode: 'HH', aiAccountName: '2000 · Accounts Payable', aiVendorName: 'Carrier HVAC', aiConfidence: 0.97, matchType: 'BILL_PAYMENT', matchLabel: 'Bill #INV-4472' },
  { id: '3', date: '2026-04-03', description: 'DEPOSIT - SMITH KITCHEN REMODEL', amountCents: 4200000, status: 'CATEGORIZED', locationName: 'Iowa Custom Cabinetry', locationCode: 'ICC', aiAccountName: '1100 · Accounts Receivable', aiVendorName: null, aiConfidence: 0.91, matchType: null, matchLabel: null },
  { id: '4', date: '2026-04-02', description: 'SHELL OIL 0087234112', amountCents: -6842, status: 'CATEGORIZED', locationName: 'Merit Management Group', locationCode: 'MMG', aiAccountName: '6200 · Fuel', aiVendorName: 'Shell', aiConfidence: 0.88, matchType: 'RECEIPT', matchLabel: 'Receipt matched' },
  { id: '5', date: '2026-04-02', description: 'UNKNOWN VENDOR PMT 8847123', amountCents: -54200, status: 'FLAGGED', locationName: 'Dorrian Mechanical', locationCode: 'DM', aiAccountName: null, aiVendorName: null, aiConfidence: 0.32, matchType: null, matchLabel: 'Unknown vendor' },
  { id: '6', date: '2026-04-02', description: 'ADP PAYROLL ACH', amountCents: -1248700, status: 'PENDING', locationName: 'Swan Creek Construction', locationCode: 'SCC', aiAccountName: '6000 · Salaries & Wages', aiVendorName: 'ADP', aiConfidence: 0.96, matchType: 'VENDOR_PATTERN', matchLabel: 'Vendor Match' },
  { id: '7', date: '2026-04-01', description: 'LOWES #2244 JOHNSTON IA', amountCents: -18944, status: 'CATEGORIZED', locationName: 'Heartland HVAC', locationCode: 'HH', aiAccountName: '5120 · Supplies', aiVendorName: "Lowe's", aiConfidence: 0.86, matchType: 'VENDOR_PATTERN', matchLabel: 'Vendor Match' },
  { id: '8', date: '2026-04-01', description: 'MICROSOFT 365 MONTHLY', amountCents: -89900, status: 'CATEGORIZED', locationName: 'Merit Management Group', locationCode: 'MMG', aiAccountName: '6300 · Software Subscriptions', aiVendorName: 'Microsoft', aiConfidence: 0.99, matchType: 'VENDOR_PATTERN', matchLabel: 'Vendor Match' },
];

function MatchBadge({ type, label }: { type: string | null; label: string | null }) {
  if (!type || !label) return null;

  const config = {
    VENDOR_PATTERN: { icon: Link2, color: 'text-slate-400 bg-slate-500/10' },
    BILL_PAYMENT: { icon: FileText, color: 'text-blue-400 bg-blue-500/10' },
    RECEIPT: { icon: Receipt, color: 'text-emerald-400 bg-emerald-500/10' },
  }[type] ?? { icon: Link2, color: 'text-slate-400 bg-slate-500/10' };

  const Icon = config.icon;

  return (
    <span className={clsx('inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-2xs font-medium', config.color)}>
      <Icon size={10} />
      {label}
    </span>
  );
}

export function BankFeedList() {
  const [selected, setSelected] = useState<Set<string>>(new Set());

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    if (selected.size === DEMO_TXNS.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(DEMO_TXNS.map((t) => t.id)));
    }
  }

  return (
    <div className="card overflow-hidden">
      <table className="w-full">
        <thead>
          <tr className="border-b border-slate-800">
            <th className="w-10 px-4 py-3">
              <input
                type="checkbox"
                checked={selected.size === DEMO_TXNS.length && DEMO_TXNS.length > 0}
                onChange={toggleAll}
                className="rounded border-slate-600 bg-transparent text-brand-500 focus:ring-brand-500/40"
              />
            </th>
            <th className="px-4 py-3 text-left text-2xs font-semibold uppercase tracking-wider text-slate-500">Date</th>
            <th className="px-4 py-3 text-left text-2xs font-semibold uppercase tracking-wider text-slate-500">Description</th>
            <th className="px-4 py-3 text-left text-2xs font-semibold uppercase tracking-wider text-slate-500">Company</th>
            <th className="px-4 py-3 text-left text-2xs font-semibold uppercase tracking-wider text-slate-500">AI Category</th>
            <th className="px-4 py-3 text-left text-2xs font-semibold uppercase tracking-wider text-slate-500 w-28">Confidence</th>
            <th className="px-4 py-3 text-right text-2xs font-semibold uppercase tracking-wider text-slate-500">Amount</th>
            <th className="px-4 py-3 text-left text-2xs font-semibold uppercase tracking-wider text-slate-500">Status</th>
            <th className="w-28 px-4 py-3"></th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-800/30">
          {DEMO_TXNS.map((txn) => (
            <tr
              key={txn.id}
              className={clsx(
                'table-row-hover',
                selected.has(txn.id) && 'bg-brand-500/[0.03]'
              )}
            >
              <td className="px-4 py-3">
                <input
                  type="checkbox"
                  checked={selected.has(txn.id)}
                  onChange={() => toggleSelect(txn.id)}
                  className="rounded border-slate-600 bg-transparent text-brand-500 focus:ring-brand-500/40"
                />
              </td>
              <td className="px-4 py-3 text-sm text-slate-400 font-mono tabular-nums whitespace-nowrap">
                {txn.date}
              </td>
              <td className="px-4 py-3">
                <div>
                  <p className="text-sm text-slate-200 truncate max-w-xs">{txn.description}</p>
                  {txn.aiVendorName && (
                    <p className="text-2xs text-slate-500 mt-0.5">{txn.aiVendorName}</p>
                  )}
                  <MatchBadge type={txn.matchType} label={txn.matchLabel} />
                </div>
              </td>
              <td className="px-4 py-3">
                <div className="flex items-center gap-2">
                  <div className="h-5 w-5 rounded bg-slate-800 flex items-center justify-center text-2xs font-bold text-slate-500">
                    {txn.locationCode.slice(0, 2)}
                  </div>
                  <span className="text-sm text-slate-300 truncate max-w-[140px]">{txn.locationName}</span>
                </div>
              </td>
              <td className="px-4 py-3">
                {txn.aiAccountName ? (
                  <span className="text-sm text-slate-300 font-mono text-xs">{txn.aiAccountName}</span>
                ) : (
                  <span className="text-sm text-slate-600 italic">Uncategorized</span>
                )}
              </td>
              <td className="px-4 py-3">
                {txn.aiConfidence != null ? (
                  <ConfidenceBar value={txn.aiConfidence} />
                ) : (
                  <span className="text-2xs text-slate-600">—</span>
                )}
              </td>
              <td className="px-4 py-3 text-right">
                <span className={clsx(
                  'text-sm font-mono tabular-nums font-medium',
                  txn.amountCents >= 0 ? 'text-emerald-400' : 'text-slate-200'
                )}>
                  {formatMoney(txn.amountCents)}
                </span>
              </td>
              <td className="px-4 py-3">
                <StatusBadge status={txn.status} />
              </td>
              <td className="px-4 py-3">
                <div className="flex items-center justify-end gap-1">
                  <button
                    className="p-1.5 rounded-md text-slate-500 hover:text-emerald-400 hover:bg-emerald-500/10 transition-colors"
                    title="Approve"
                  >
                    <Check size={14} />
                  </button>
                  <button
                    className="p-1.5 rounded-md text-slate-500 hover:text-slate-200 hover:bg-white/[0.04] transition-colors"
                    title="Edit"
                  >
                    <Pencil size={14} />
                  </button>
                  <button
                    className="p-1.5 rounded-md text-slate-500 hover:text-amber-400 hover:bg-amber-500/10 transition-colors"
                    title="Flag"
                  >
                    <Flag size={14} />
                  </button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
