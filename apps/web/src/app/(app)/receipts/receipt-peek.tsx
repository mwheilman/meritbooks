'use client';

import { usePeekDetail } from '@/components/hover-peek';
import { formatMoney } from '@meritbooks/shared';
import { Loader2, ImageOff } from 'lucide-react';

interface ReceiptDetail {
  imageUrl: string | null; vendorName: string | null; amountCents: number | null;
  receiptDate: string | null; accountLabel: string | null; status: string;
}

/** Shows the actual uploaded receipt image — the real "copy of the receipt". */
export function ReceiptPeek({ receiptId }: { receiptId: string }) {
  const { data, loading } = usePeekDetail<ReceiptDetail>(`/api/receipts/${receiptId}`);
  if (loading && !data) return <div className="flex items-center justify-center py-10"><Loader2 size={18} className="animate-spin text-slate-500" /></div>;
  if (!data) return <div className="px-3 py-6 text-center text-xs text-slate-500">Preview unavailable</div>;

  return (
    <div>
      {data.imageUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={data.imageUrl} alt="Receipt" className="w-full max-h-64 object-contain bg-slate-950 border-b border-slate-800" />
      ) : (
        <div className="flex flex-col items-center justify-center py-8 text-slate-600 bg-slate-950 border-b border-slate-800">
          <ImageOff size={22} /><span className="text-2xs mt-1">No image attached</span>
        </div>
      )}
      <div className="px-3 py-2 space-y-1">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium text-white truncate">{data.vendorName ?? 'Unknown vendor'}</span>
          <span className="text-sm font-mono tabular-nums text-slate-200">{data.amountCents != null ? formatMoney(data.amountCents) : '--'}</span>
        </div>
        <div className="flex items-center justify-between text-2xs text-slate-500">
          <span>{data.receiptDate ?? '--'}</span>
          <span className="truncate ml-2">{data.accountLabel ?? 'Uncategorized'}</span>
        </div>
      </div>
    </div>
  );
}
