'use client';

import { usePeekDetail } from '@/components/hover-peek';
import { formatMoney } from '@meritbooks/shared';
import { Loader2 } from 'lucide-react';

interface BillLine { id: string; description: string | null; amount_cents: number; }
interface BillDetail {
  bill_number: string | null; bill_date: string; due_date: string; status: string;
  subtotal_cents: number; tax_cents: number; total_cents: number; balance_cents: number;
  vendor: { name: string; display_name: string | null } | null;
  location: { name: string; short_code: string } | null;
  lines: BillLine[];
}

/** A miniature of the vendor bill for the hover-peek. */
export function BillPeek({ billId }: { billId: string }) {
  const { data, loading } = usePeekDetail<BillDetail>(`/api/bills/${billId}`);
  if (loading && !data) return <div className="flex items-center justify-center py-10"><Loader2 size={18} className="animate-spin text-slate-500" /></div>;
  if (!data) return <div className="px-3 py-6 text-center text-xs text-slate-500">Preview unavailable</div>;

  const shown = data.lines.slice(0, 6);
  const more = data.lines.length - shown.length;
  const vendorName = data.vendor?.display_name ?? data.vendor?.name ?? 'Vendor';

  return (
    <div className="bg-white text-slate-800 m-2 rounded-lg p-3 text-[11px] leading-relaxed">
      <div className="flex items-start justify-between mb-2">
        <div>
          <div className="font-semibold text-slate-900 text-xs">{vendorName}</div>
          <div className="text-[10px] text-slate-500">Vendor Bill{data.location ? ` · ${data.location.short_code}` : ''}</div>
        </div>
        <div className="text-right">
          <div className="font-mono font-semibold text-slate-900">{data.bill_number ?? '--'}</div>
          <div className="text-[10px] text-slate-500">{data.bill_date}</div>
        </div>
      </div>
      <div className="border-t border-slate-200 pt-1.5 mb-1.5 text-[10px] text-slate-500">
        Due <span className="font-medium text-slate-700">{data.due_date}</span>
      </div>
      <table className="w-full">
        <tbody>
          {shown.map((l) => (
            <tr key={l.id} className="border-b border-slate-100">
              <td className="py-0.5 pr-2 text-slate-700 truncate max-w-[180px]">{l.description ?? 'Line'}</td>
              <td className="py-0.5 text-right font-mono text-slate-700 whitespace-nowrap">{formatMoney(l.amount_cents)}</td>
            </tr>
          ))}
          {more > 0 && <tr><td className="py-0.5 text-[10px] text-slate-400 italic" colSpan={2}>+ {more} more line{more > 1 ? 's' : ''}</td></tr>}
        </tbody>
      </table>
      <div className="mt-1.5 pt-1.5 border-t border-slate-200 space-y-0.5">
        <div className="flex justify-between"><span className="text-slate-500">Subtotal</span><span className="font-mono text-slate-700">{formatMoney(data.subtotal_cents)}</span></div>
        {data.tax_cents > 0 && <div className="flex justify-between"><span className="text-slate-500">Tax</span><span className="font-mono text-slate-700">{formatMoney(data.tax_cents)}</span></div>}
        <div className="flex justify-between"><span className="font-semibold text-slate-900">Total</span><span className="font-mono font-semibold text-slate-900">{formatMoney(data.total_cents)}</span></div>
        <div className="flex justify-between"><span className="font-semibold text-slate-900">Balance</span><span className={`font-mono font-semibold ${data.balance_cents > 0 ? 'text-rose-600' : 'text-slate-900'}`}>{formatMoney(data.balance_cents)}</span></div>
      </div>
    </div>
  );
}
