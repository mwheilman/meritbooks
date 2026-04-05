'use client';

import { Check, Flag, Pencil, Receipt, Bell, Camera, Clock } from 'lucide-react';
import { clsx } from 'clsx';
import { StatusBadge, ConfidenceBar } from '@/components/ui';
import { formatMoney } from '@meritbooks/shared';

interface CCTxn {
  id: string;
  date: string;
  description: string;
  amountCents: number;
  cardHolder: string;
  cardMask: string;
  status: string;
  locationCode: string;
  aiAccount: string | null;
  aiConfidence: number | null;
  receiptStatus: 'MATCHED' | 'MISSING' | 'PENDING';
  chaseCount: number;
  lastChase: string | null;
}

const DEMO_CC: CCTxn[] = [
  { id: '1', date: '2026-04-03', description: 'MENARDS AMES IA', amountCents: 34218, cardHolder: 'Jake T.', cardMask: '4418', status: 'CATEGORIZED', locationCode: 'SCC', aiAccount: '5100 · Materials', aiConfidence: 0.94, receiptStatus: 'MATCHED', chaseCount: 0, lastChase: null },
  { id: '2', date: '2026-04-03', description: 'SHELL OIL 0087234', amountCents: 6842, cardHolder: 'Carlos R.', cardMask: '8820', status: 'CATEGORIZED', locationCode: 'MMG', aiAccount: '6200 · Fuel', aiConfidence: 0.97, receiptStatus: 'MATCHED', chaseCount: 0, lastChase: null },
  { id: '3', date: '2026-04-02', description: 'CASEYS GEN STORE', amountCents: 4218, cardHolder: 'Jake T.', cardMask: '4418', status: 'PENDING', locationCode: 'SCC', aiAccount: '6200 · Fuel', aiConfidence: 0.85, receiptStatus: 'MISSING', chaseCount: 2, lastChase: '15min ago' },
  { id: '4', date: '2026-04-01', description: 'GRAINGER INC', amountCents: 34200, cardHolder: 'Marcus W.', cardMask: '7712', status: 'PENDING', locationCode: 'HH', aiAccount: '5120 · Supplies', aiConfidence: 0.88, receiptStatus: 'MISSING', chaseCount: 5, lastChase: '32min ago' },
  { id: '5', date: '2026-03-30', description: 'FASTENAL CO', amountCents: 8940, cardHolder: 'Tyler B.', cardMask: '3301', status: 'FLAGGED', locationCode: 'DM', aiAccount: '5100 · Materials', aiConfidence: 0.72, receiptStatus: 'MISSING', chaseCount: 8, lastChase: '1hr ago' },
  { id: '6', date: '2026-04-03', description: 'AMAZON MKTPLCE', amountCents: 12499, cardHolder: 'Sarah M.', cardMask: '1002', status: 'CATEGORIZED', locationCode: 'MMG', aiAccount: '6600 · Office Supplies', aiConfidence: 0.91, receiptStatus: 'PENDING', chaseCount: 0, lastChase: null },
];

function ReceiptBadge({ status, chaseCount }: { status: string; chaseCount: number }) {
  if (status === 'MATCHED') {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-2xs font-medium bg-emerald-500/10 text-emerald-400">
        <Receipt size={10} />
        Matched
      </span>
    );
  }
  if (status === 'MISSING') {
    return (
      <span className={clsx(
        'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-2xs font-medium',
        chaseCount >= 5 ? 'bg-red-500/10 text-red-400' : 'bg-amber-500/10 text-amber-400',
      )}>
        <Bell size={10} />
        Chase ({chaseCount})
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-2xs font-medium bg-blue-500/10 text-blue-400">
      <Clock size={10} />
      Pending
    </span>
  );
}

export function CreditCardFeed() {
  return (
    <div className="card overflow-hidden">
      <table className="w-full">
        <thead>
          <tr className="border-b border-slate-800">
            <th className="px-5 py-3 text-left text-2xs font-semibold uppercase tracking-wider text-slate-500">Date</th>
            <th className="px-4 py-3 text-left text-2xs font-semibold uppercase tracking-wider text-slate-500">Description</th>
            <th className="px-4 py-3 text-left text-2xs font-semibold uppercase tracking-wider text-slate-500">Card</th>
            <th className="px-4 py-3 text-left text-2xs font-semibold uppercase tracking-wider text-slate-500">AI Category</th>
            <th className="px-4 py-3 text-left text-2xs font-semibold uppercase tracking-wider text-slate-500 w-24">Confidence</th>
            <th className="px-4 py-3 text-right text-2xs font-semibold uppercase tracking-wider text-slate-500">Amount</th>
            <th className="px-4 py-3 text-center text-2xs font-semibold uppercase tracking-wider text-slate-500">Receipt</th>
            <th className="px-4 py-3 text-center text-2xs font-semibold uppercase tracking-wider text-slate-500">Status</th>
            <th className="w-24 px-4 py-3"></th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-800/30">
          {DEMO_CC.map((txn) => (
            <tr key={txn.id} className="table-row-hover">
              <td className="px-5 py-3 text-sm text-slate-400 font-mono tabular-nums whitespace-nowrap">{txn.date}</td>
              <td className="px-4 py-3">
                <p className="text-sm text-slate-200 truncate max-w-[200px]">{txn.description}</p>
                <p className="text-2xs text-slate-500">{txn.locationCode}</p>
              </td>
              <td className="px-4 py-3">
                <p className="text-sm text-slate-300">{txn.cardHolder}</p>
                <p className="text-2xs text-slate-500 font-mono">·{txn.cardMask}</p>
              </td>
              <td className="px-4 py-3">
                {txn.aiAccount ? (
                  <span className="text-xs font-mono text-slate-400">{txn.aiAccount}</span>
                ) : (
                  <span className="text-xs text-slate-600 italic">—</span>
                )}
              </td>
              <td className="px-4 py-3">
                {txn.aiConfidence != null && <ConfidenceBar value={txn.aiConfidence} />}
              </td>
              <td className="px-4 py-3 text-right text-sm font-mono tabular-nums text-slate-200">
                {formatMoney(txn.amountCents)}
              </td>
              <td className="px-4 py-3 text-center">
                <ReceiptBadge status={txn.receiptStatus} chaseCount={txn.chaseCount} />
              </td>
              <td className="px-4 py-3 text-center">
                <StatusBadge status={txn.status} />
              </td>
              <td className="px-4 py-3">
                <div className="flex items-center justify-end gap-1">
                  <button className="p-1.5 rounded-md text-slate-500 hover:text-emerald-400 hover:bg-emerald-500/10 transition-colors" title="Approve"><Check size={14} /></button>
                  <button className="p-1.5 rounded-md text-slate-500 hover:text-slate-200 hover:bg-white/[0.04] transition-colors" title="Edit"><Pencil size={14} /></button>
                  <button className="p-1.5 rounded-md text-slate-500 hover:text-amber-400 hover:bg-amber-500/10 transition-colors" title="Flag"><Flag size={14} /></button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
