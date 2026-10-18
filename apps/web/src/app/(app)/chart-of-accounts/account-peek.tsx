'use client';
import { usePeekDetail } from '@/components/hover-peek';
import { formatMoney } from '@meritbooks/shared';
import { Loader2, Lock } from 'lucide-react';

interface AcctDetail {
  accountNumber: string; name: string; accountType: string; accountSubType: string | null;
  isControl: boolean; naturalBalanceCents: number; normalBalance: string; activityCount: number;
  recentActivity: Array<{ id: string; entryNumber: string; entryDate: string; debitCents: number; creditCents: number }>;
}

export function AccountPeek({ accountId }: { accountId: string }) {
  const { data, loading } = usePeekDetail<AcctDetail>(`/api/accounts/${accountId}`);
  if (loading && !data) return <div className="flex items-center justify-center py-8"><Loader2 size={18} className="animate-spin text-slate-500" /></div>;
  if (!data) return <div className="px-3 py-6 text-center text-xs text-slate-500">Preview unavailable</div>;
  return (
    <div className="p-3">
      <div className="flex items-center gap-2 mb-1">
        <span className="font-mono text-xs text-brand-400">{data.accountNumber}</span>
        <span className="text-sm font-semibold text-white truncate">{data.name}</span>
        {data.isControl && <Lock size={11} className="text-amber-500/70" />}
      </div>
      <div className="text-2xs text-slate-500 mb-2">{data.accountType}{data.accountSubType ? ` · ${data.accountSubType}` : ''}</div>
      <div className="rounded-md bg-slate-800/40 px-3 py-2 flex items-center justify-between">
        <span className="text-2xs text-slate-500">Balance ({data.normalBalance})</span>
        <span className="text-sm font-mono tabular-nums text-white">{formatMoney(data.naturalBalanceCents)}</span>
      </div>
      {data.recentActivity.length > 0 && (
        <div className="mt-2">
          <div className="text-2xs text-slate-500 uppercase tracking-wider font-semibold mb-1">Recent activity</div>
          {data.recentActivity.slice(0, 4).map((e) => (
            <div key={e.id + e.entryNumber} className="flex items-center justify-between text-2xs py-0.5">
              <span className="text-slate-400 font-mono">{e.entryNumber}</span>
              <span className="text-slate-500">{e.entryDate}</span>
              <span className="text-slate-300 font-mono tabular-nums">{formatMoney(e.debitCents || e.creditCents)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
