'use client';
import { usePeekDetail } from '@/components/hover-peek';
import { formatMoney } from '@meritbooks/shared';
import { Loader2, ShieldAlert } from 'lucide-react';

interface VenDetail {
  name: string; email: string | null; phone: string | null; paymentTermsDays: number | null;
  is1099: boolean; autoApprove: boolean;
  compliance: { hasPaymentHold: boolean };
  ap: { openBalance: number; overdueCount: number; openBillCount: number };
}

export function VendorPeek({ vendorId }: { vendorId: string }) {
  const { data, loading } = usePeekDetail<VenDetail>(`/api/vendors/${vendorId}`);
  if (loading && !data) return <div className="flex items-center justify-center py-8"><Loader2 size={18} className="animate-spin text-slate-500" /></div>;
  if (!data) return <div className="px-3 py-6 text-center text-xs text-slate-500">Preview unavailable</div>;
  return (
    <div className="p-3">
      <div className="flex items-center gap-2 mb-2">
        <span className="text-sm font-semibold text-white truncate">{data.name}</span>
        {data.is1099 && <span className="text-2xs text-slate-500 font-mono">1099</span>}
        {data.compliance.hasPaymentHold && <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-2xs font-medium bg-rose-500/10 text-rose-400"><ShieldAlert size={9} /> HOLD</span>}
      </div>
      <div className="space-y-0.5 mb-2">
        {data.email && <div className="text-2xs text-slate-500">{data.email}</div>}
        {data.phone && <div className="text-2xs text-slate-500">{data.phone}</div>}
      </div>
      <div className="rounded-md bg-slate-800/40 px-3 py-2">
        <div className="flex items-center justify-between">
          <span className="text-2xs text-slate-500">Open A/P</span>
          <span className="text-sm font-mono tabular-nums text-white">{formatMoney(data.ap.openBalance)}</span>
        </div>
        <div className="flex items-center justify-between mt-0.5">
          <span className="text-2xs text-slate-500">{data.ap.openBillCount} open bill{data.ap.openBillCount !== 1 ? 's' : ''}</span>
          {data.ap.overdueCount > 0 && <span className="text-2xs text-rose-400">{data.ap.overdueCount} overdue</span>}
        </div>
      </div>
      <div className="mt-2 flex items-center justify-between text-2xs text-slate-500">
        {data.paymentTermsDays != null && <span>Terms: Net {data.paymentTermsDays}</span>}
        {data.autoApprove && <span className="text-emerald-400">Auto-approve</span>}
      </div>
    </div>
  );
}
