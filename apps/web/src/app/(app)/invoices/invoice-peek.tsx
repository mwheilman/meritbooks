'use client';

import { usePeekDetail } from '@/components/hover-peek';
import { formatMoney } from '@meritbooks/shared';
import { Loader2 } from 'lucide-react';

interface InvLine { id: string; description: string; quantity: number; unitPriceCents: number; amountCents: number; }
interface InvDetail {
  invoiceNumber: string; invoiceDate: string; dueDate: string; status: string;
  subtotalCents: number; taxCents: number; totalCents: number; balanceCents: number;
  customerName: string; locationName: string; lines: InvLine[];
}

/** A miniature of the actual invoice document for the hover-peek. */
export function InvoicePeek({ invoiceId }: { invoiceId: string }) {
  const { data, loading } = usePeekDetail<InvDetail>(`/api/invoices/${invoiceId}`);

  if (loading && !data) {
    return <div className="flex items-center justify-center py-10"><Loader2 size={18} className="animate-spin text-slate-500" /></div>;
  }
  if (!data) return <div className="px-3 py-6 text-center text-xs text-slate-500">Preview unavailable</div>;

  const shown = (data.lines ?? []).slice(0, 6);
  const more = (data.lines?.length ?? 0) - shown.length;

  return (
    <div className="bg-white text-slate-800 m-2 rounded-lg p-3 text-[11px] leading-relaxed">
      <div className="flex items-start justify-between mb-2">
        <div>
          <div className="font-semibold text-slate-900 text-xs">{data.locationName || 'Company'}</div>
          <div className="text-[10px] text-slate-500">Invoice</div>
        </div>
        <div className="text-right">
          <div className="font-mono font-semibold text-slate-900">{data.invoiceNumber}</div>
          <div className="text-[10px] text-slate-500">{data.invoiceDate}</div>
        </div>
      </div>
      <div className="border-t border-slate-200 pt-1.5 mb-1.5">
        <span className="text-[10px] text-slate-500">Bill to </span>
        <span className="font-medium text-slate-700">{data.customerName || '--'}</span>
        <span className="float-right text-[10px] text-slate-500">Due {data.dueDate}</span>
      </div>
      <table className="w-full">
        <tbody>
          {shown.map((l) => (
            <tr key={l.id} className="border-b border-slate-100">
              <td className="py-0.5 pr-2 text-slate-700 truncate max-w-[180px]">{l.description}</td>
              <td className="py-0.5 text-right font-mono text-slate-700 whitespace-nowrap">{formatMoney(l.amountCents)}</td>
            </tr>
          ))}
          {more > 0 && (
            <tr><td className="py-0.5 text-[10px] text-slate-400 italic" colSpan={2}>+ {more} more line{more > 1 ? 's' : ''}</td></tr>
          )}
        </tbody>
      </table>
      <div className="mt-1.5 pt-1.5 border-t border-slate-200 space-y-0.5">
        <Row label="Subtotal" value={formatMoney(data.subtotalCents)} />
        {data.taxCents > 0 && <Row label="Tax" value={formatMoney(data.taxCents)} />}
        <Row label="Total" value={formatMoney(data.totalCents)} bold />
        <Row label="Balance due" value={formatMoney(data.balanceCents)} bold accent={data.balanceCents > 0} />
      </div>
    </div>
  );
}

function Row({ label, value, bold, accent }: { label: string; value: string; bold?: boolean; accent?: boolean }) {
  return (
    <div className="flex justify-between">
      <span className={bold ? 'font-semibold text-slate-900' : 'text-slate-500'}>{label}</span>
      <span className={`font-mono ${accent ? 'text-rose-600 font-semibold' : bold ? 'text-slate-900 font-semibold' : 'text-slate-700'}`}>{value}</span>
    </div>
  );
}
