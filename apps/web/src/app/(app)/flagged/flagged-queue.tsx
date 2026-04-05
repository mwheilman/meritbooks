'use client';

import { AlertTriangle, Bot, User, ArrowRight } from 'lucide-react';
import { clsx } from 'clsx';
import { StatusBadge } from '@/components/ui';
import { formatMoney } from '@meritbooks/shared';

interface FlaggedItem {
  id: string;
  type: 'bank_txn' | 'receipt' | 'bill' | 'je';
  description: string;
  amountCents: number;
  locationCode: string;
  flaggedBy: 'AI' | 'HUMAN';
  flaggedByName: string;
  reason: string;
  date: string;
  priority: 'HIGH' | 'MEDIUM' | 'LOW';
}

const DEMO_FLAGGED: FlaggedItem[] = [
  { id: '1', type: 'bank_txn', description: 'UNKNOWN VENDOR PMT 8847123', amountCents: 54200, locationCode: 'DM', flaggedBy: 'AI', flaggedByName: 'Claude', reason: 'Unknown vendor — $542 charge with no matching pattern, receipt, or bill. Confidence 32%.', date: '2026-04-02', priority: 'HIGH' },
  { id: '2', type: 'receipt', description: 'Illegible receipt — Tyler B.', amountCents: 18944, locationCode: 'DM', flaggedBy: 'AI', flaggedByName: 'Claude', reason: 'OCR extraction failed — vendor name and line items unreadable. Manual review required.', date: '2026-03-31', priority: 'MEDIUM' },
  { id: '3', type: 'bill', description: 'Smith Plumbing Co — Invoice SP-2026-044', amountCents: 124000, locationCode: 'ICC', flaggedBy: 'AI', flaggedByName: 'Claude', reason: 'Vendor has 3 missing compliance documents (W-9, GL COI, WC COI). Payment held automatically.', date: '2026-02-10', priority: 'HIGH' },
  { id: '4', type: 'bank_txn', description: 'WIRE TRANSFER 00884421', amountCents: 1500000, locationCode: 'MMG', flaggedBy: 'HUMAN', flaggedByName: 'Sarah M.', reason: 'Large wire — needs CFO approval. Appears to be equipment purchase but no PO on file.', date: '2026-04-01', priority: 'HIGH' },
  { id: '5', type: 'je', description: 'JE-2026-000847 — Prepaid amortization', amountCents: 185000, locationCode: 'MMG', flaggedBy: 'HUMAN', flaggedByName: 'Sarah M.', reason: 'Amortization schedule may be incorrect — policy term changed mid-year. Need to verify remaining balance.', date: '2026-04-01', priority: 'LOW' },
  { id: '6', type: 'bank_txn', description: 'PAYPAL *MARKETPLACE', amountCents: 29900, locationCode: 'AIN', flaggedBy: 'AI', flaggedByName: 'Claude', reason: 'PayPal transaction — could be personal expense on company card. No receipt submitted. Chase reminder #3 sent.', date: '2026-03-29', priority: 'MEDIUM' },
];

const TYPE_LABELS: Record<string, string> = {
  bank_txn: 'Bank Txn',
  receipt: 'Receipt',
  bill: 'Bill',
  je: 'Journal Entry',
};

const PRIORITY_COLORS: Record<string, string> = {
  HIGH: 'border-l-red-500',
  MEDIUM: 'border-l-amber-500',
  LOW: 'border-l-slate-600',
};

export function FlaggedQueue() {
  return (
    <div className="space-y-2">
      {DEMO_FLAGGED.map((item) => (
        <div
          key={item.id}
          className={clsx(
            'card border-l-2 p-4 hover:bg-white/[0.01] transition-colors cursor-pointer',
            PRIORITY_COLORS[item.priority],
          )}
        >
          <div className="flex items-start gap-4">
            {/* Icon */}
            <div className={clsx(
              'h-8 w-8 rounded-lg flex items-center justify-center shrink-0',
              item.flaggedBy === 'AI' ? 'bg-purple-500/10' : 'bg-blue-500/10',
            )}>
              {item.flaggedBy === 'AI'
                ? <Bot size={16} className="text-purple-400" />
                : <User size={16} className="text-blue-400" />
              }
            </div>

            {/* Content */}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1">
                <span className="text-xs text-slate-500 bg-slate-800 px-1.5 py-0.5 rounded">{TYPE_LABELS[item.type]}</span>
                <span className="text-xs text-slate-600">{item.locationCode}</span>
                <span className="text-xs text-slate-600">·</span>
                <span className="text-xs text-slate-500">{item.date}</span>
                <span className="ml-auto text-xs text-slate-500">by {item.flaggedByName}</span>
              </div>
              <p className="text-sm font-medium text-slate-200 mb-1">{item.description}</p>
              <p className="text-sm text-slate-400">{item.reason}</p>
            </div>

            {/* Amount + actions */}
            <div className="flex flex-col items-end gap-2 shrink-0">
              <span className="text-sm font-mono tabular-nums text-white font-medium">
                {formatMoney(item.amountCents)}
              </span>
              <button className="btn-primary btn-sm">
                Review <ArrowRight size={12} />
              </button>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
