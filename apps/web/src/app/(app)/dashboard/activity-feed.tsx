'use client';

import { Receipt, FileText, CheckCircle, ArrowRightLeft, Landmark } from 'lucide-react';
import { clsx } from 'clsx';

interface ActivityItem {
  id: string;
  icon: 'receipt' | 'bill' | 'approval' | 'transfer' | 'bank';
  text: string;
  detail: string;
  time: string;
}

const ICON_MAP = {
  receipt: { icon: Receipt, color: 'text-blue-400 bg-blue-500/10' },
  bill: { icon: FileText, color: 'text-amber-400 bg-amber-500/10' },
  approval: { icon: CheckCircle, color: 'text-emerald-400 bg-emerald-500/10' },
  transfer: { icon: ArrowRightLeft, color: 'text-purple-400 bg-purple-500/10' },
  bank: { icon: Landmark, color: 'text-slate-400 bg-slate-500/10' },
};

// Demo data
const DEMO_ACTIVITY: ActivityItem[] = [
  { id: '1', icon: 'approval', text: 'Sarah approved 12 bank transactions', detail: 'Swan Creek Construction', time: '2m ago' },
  { id: '2', icon: 'receipt', text: 'AI categorized receipt from Menards', detail: '$342.18 · 94% confidence', time: '5m ago' },
  { id: '3', icon: 'bill', text: 'New bill from Carrier HVAC', detail: '$8,240.00 · Heartland HVAC', time: '12m ago' },
  { id: '4', icon: 'bank', text: '23 new bank transactions synced', detail: 'Across 4 entities', time: '15m ago' },
  { id: '5', icon: 'approval', text: 'Mike approved JE-2026-000847', detail: 'Payroll · Merit Management', time: '28m ago' },
  { id: '6', icon: 'receipt', text: 'Missing receipt chase sent', detail: 'Shell Gas · $68.42 · Visa ·8820', time: '32m ago' },
  { id: '7', icon: 'transfer', text: 'Intercompany transfer requested', detail: '$15K MMG → Dorrian Mechanical', time: '1h ago' },
  { id: '8', icon: 'bill', text: 'Vendor compliance warning', detail: 'ABC Electric · GL COI expired', time: '1h ago' },
];

export function ActivityFeed() {
  return (
    <div className="card">
      <div className="px-5 py-4 border-b border-slate-800 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-white">Activity</h2>
        <span className="text-2xs text-slate-500">Live</span>
      </div>
      <div className="divide-y divide-slate-800/30">
        {DEMO_ACTIVITY.map((item) => {
          const { icon: Icon, color } = ICON_MAP[item.icon];
          return (
            <div key={item.id} className="px-5 py-3 table-row-hover">
              <div className="flex gap-3">
                <div className={clsx('h-7 w-7 rounded-lg flex items-center justify-center shrink-0 mt-0.5', color)}>
                  <Icon size={14} />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-slate-200 truncate">{item.text}</p>
                  <p className="text-2xs text-slate-500 mt-0.5">{item.detail}</p>
                </div>
                <span className="text-2xs text-slate-600 shrink-0">{item.time}</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
