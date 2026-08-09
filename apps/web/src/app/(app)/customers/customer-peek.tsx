'use client';
import { usePeekDetail } from '@/components/hover-peek';
import { formatMoney } from '@meritbooks/shared';
import { Loader2, Mail, Phone } from 'lucide-react';

interface CustDetail {
  name: string; email: string | null; phone: string | null; contactName: string | null;
  paymentTermsDays: number | null; isPortfolioCompany: boolean;
  ar: { totalOutstanding: number; overdueCount: number; openInvoiceCount: number };
  recentInvoices: Array<{ id: string; invoiceNumber: string; balanceCents: number }>;
}

export function CustomerPeek({ customerId }: { customerId: string }) {
  const { data, loading } = usePeekDetail<CustDetail>(`/api/customers/${customerId}`);
  if (loading && !data) return <div className="flex items-center justify-center py-8"><Loader2 size={18} className="animate-spin text-slate-500" /></div>;
  if (!data) return <div className="px-3 py-6 text-center text-xs text-slate-500">Preview unavailable</div>;
  return (
    <div className="p-3">
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm font-semibold text-white truncate">{data.name}</span>
        {data.isPortfolioCompany && <span className="px-1.5 py-0.5 rounded text-2xs font-medium bg-emerald-500/15 text-emerald-400">Internal</span>}
      </div>
      {data.contactName && <div className="text-2xs text-slate-400 mb-1">{data.contactName}</div>}
      <div className="space-y-0.5 mb-2">
        {data.email && <div className="flex items-center gap-1.5 text-2xs text-slate-500"><Mail size={10} /> {data.email}</div>}
        {data.phone && <div className="flex items-center gap-1.5 text-2xs text-slate-500"><Phone size={10} /> {data.phone}</div>}
      </div>
      <div className="rounded-md bg-slate-800/40 px-3 py-2">
        <div className="flex items-center justify-between">
          <span className="text-2xs text-slate-500">Open A/R</span>
          <span className="text-sm font-mono tabular-nums text-white">{formatMoney(data.ar.totalOutstanding)}</span>
        </div>
        <div className="flex items-center justify-between mt-0.5">
          <span className="text-2xs text-slate-500">{data.ar.openInvoiceCount} open invoice{data.ar.openInvoiceCount !== 1 ? 's' : ''}</span>
          {data.ar.overdueCount > 0 && <span className="text-2xs text-rose-400">{data.ar.overdueCount} overdue</span>}
        </div>
      </div>
      {data.paymentTermsDays != null && <div className="mt-2 text-2xs text-slate-500">Terms: Net {data.paymentTermsDays}</div>}
    </div>
  );
}
