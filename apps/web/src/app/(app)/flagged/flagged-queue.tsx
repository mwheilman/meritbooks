'use client';

import { useState } from 'react';
import { AlertTriangle, Landmark, Receipt, FileText, Inbox, AlertCircle } from 'lucide-react';
import { clsx } from 'clsx';
import { EmptyState, TableSkeleton } from '@/components/ui';
import { formatMoney } from '@meritbooks/shared';
import { useQuery } from '@/hooks';
import { CompanySelector } from '../bank-feed/company-selector';

interface FlaggedItem {
  id: string;
  type: 'bank_txn' | 'receipt' | 'bill';
  description: string;
  amountCents: number;
  reason: string | null;
  date: string;
  locationCode: string | null;
  locationName: string | null;
}

interface FlaggedResponse {
  data: FlaggedItem[];
  counts: { bank_txn: number; receipt: number; bill: number; total: number };
}

const TYPE_CONFIG = {
  bank_txn: { icon: Landmark, label: 'Bank Txn', className: 'text-blue-400 bg-blue-500/10' },
  receipt: { icon: Receipt, label: 'Receipt', className: 'text-purple-400 bg-purple-500/10' },
  bill: { icon: FileText, label: 'Bill', className: 'text-amber-400 bg-amber-500/10' },
};

export function FlaggedQueue() {
  const [locationId, setLocationId] = useState<string | null>(null);

  const params: Record<string, string> = {};
  if (locationId) params.location_id = locationId;

  const { data, isLoading, error } = useQuery<FlaggedResponse>(
    '/api/flagged',
    Object.keys(params).length > 0 ? params : undefined,
  );

  const items = data?.data ?? [];
  const counts = data?.counts ?? null;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-4">
        <CompanySelector selectedId={locationId} onChange={setLocationId} />
        {counts && counts.total > 0 && (
          <div className="flex items-center gap-3 text-sm text-slate-400">
            <span className="font-mono tabular-nums text-brand-400">{counts.total}</span> items
            {counts.bank_txn > 0 && <span className="text-2xs">({counts.bank_txn} txns</span>}
            {counts.receipt > 0 && <span className="text-2xs">{counts.receipt} receipts</span>}
            {counts.bill > 0 && <span className="text-2xs">{counts.bill} bills)</span>}
          </div>
        )}
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="card p-5 animate-pulse h-24" />
          ))}
        </div>
      ) : error ? (
        <div className="card p-8 text-center">
          <AlertCircle size={24} className="mx-auto text-red-400 mb-2" />
          <p className="text-sm text-red-400 font-medium">{error}</p>
        </div>
      ) : items.length === 0 ? (
        <EmptyState
          icon={Inbox}
          title="No flagged items"
          description="All transactions are categorized and approved. Nothing needs attention right now."
        />
      ) : (
        <div className="space-y-2">
          {items.map((item) => {
            const config = TYPE_CONFIG[item.type];
            const Icon = config.icon;

            return (
              <div
                key={`${item.type}-${item.id}`}
                className="card border-l-2 border-l-amber-500 hover:border-l-amber-400 transition-colors"
              >
                <div className="px-5 py-4">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex items-start gap-3 min-w-0">
                      <div className={clsx('h-8 w-8 rounded-lg flex items-center justify-center shrink-0 mt-0.5', config.className)}>
                        <Icon size={16} />
                      </div>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <span className={clsx('inline-flex items-center px-1.5 py-0.5 rounded text-2xs font-medium', config.className)}>
                            {config.label}
                          </span>
                          {item.locationCode && (
                            <span className="text-2xs font-mono text-slate-500 bg-slate-800 px-1 py-0.5 rounded">
                              {item.locationCode}
                            </span>
                          )}
                          <span className="text-2xs text-slate-600 font-mono tabular-nums">{item.date}</span>
                        </div>
                        <p className="text-sm text-slate-200 mb-1">{item.description}</p>
                        {item.reason && (
                          <p className="text-xs text-slate-400 leading-relaxed">{item.reason}</p>
                        )}
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <span className="text-sm font-mono tabular-nums font-medium text-slate-200">
                        {formatMoney(item.amountCents)}
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
