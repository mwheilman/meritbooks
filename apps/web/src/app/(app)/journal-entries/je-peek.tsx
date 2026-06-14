'use client';

import { usePeekDetail } from '@/components/hover-peek';
import { formatMoney } from '@meritbooks/shared';
import { Loader2 } from 'lucide-react';

interface JELine { id: string; accountNumber: string; accountName: string; debitCents: number; creditCents: number; }
interface JEDetail {
  entryNumber: string; entryDate: string; memo: string | null; status: string;
  totalDebitsCents: number; totalCreditsCents: number; balanced: boolean; lines: JELine[];
}

/** A mini debit/credit ledger view — the natural way to read a JE at a glance. */
export function JournalEntryPeek({ entryId }: { entryId: string }) {
  const { data, loading } = usePeekDetail<JEDetail>(`/api/journal-entries/${entryId}`);

  if (loading && !data) {
    return <div className="flex items-center justify-center py-10"><Loader2 size={18} className="animate-spin text-slate-500" /></div>;
  }
  if (!data) return <div className="px-3 py-6 text-center text-xs text-slate-500">Preview unavailable</div>;

  const shown = data.lines.slice(0, 7);
  const more = data.lines.length - shown.length;

  return (
    <div className="p-3 text-xs">
      <div className="flex items-center justify-between mb-2">
        <span className="font-mono font-semibold text-white">{data.entryNumber}</span>
        <span className="text-2xs text-slate-500">{data.entryDate}</span>
      </div>
      {data.memo && <div className="text-2xs text-slate-400 mb-2 truncate">{data.memo}</div>}
      <table className="w-full">
        <thead>
          <tr className="text-2xs text-slate-500 uppercase tracking-wider">
            <th className="text-left font-semibold pb-1">Account</th>
            <th className="text-right font-semibold pb-1">Dr</th>
            <th className="text-right font-semibold pb-1">Cr</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((l) => (
            <tr key={l.id} className="border-t border-slate-800/60">
              <td className="py-1 pr-2 text-slate-300 truncate max-w-[150px]">
                <span className="font-mono text-2xs text-slate-500">{l.accountNumber}</span> {l.accountName}
              </td>
              <td className="py-1 text-right font-mono tabular-nums text-slate-200">{l.debitCents ? formatMoney(l.debitCents) : ''}</td>
              <td className="py-1 text-right font-mono tabular-nums text-slate-200">{l.creditCents ? formatMoney(l.creditCents) : ''}</td>
            </tr>
          ))}
          {more > 0 && <tr><td className="py-1 text-2xs text-slate-500 italic" colSpan={3}>+ {more} more</td></tr>}
          <tr className="border-t border-slate-700 font-semibold">
            <td className="py-1 text-2xs text-slate-400">Totals</td>
            <td className="py-1 text-right font-mono tabular-nums text-slate-100">{formatMoney(data.totalDebitsCents)}</td>
            <td className="py-1 text-right font-mono tabular-nums text-slate-100">{formatMoney(data.totalCreditsCents)}</td>
          </tr>
        </tbody>
      </table>
      <div className={`mt-1.5 text-2xs font-medium ${data.balanced ? 'text-emerald-400' : 'text-rose-400'}`}>
        {data.balanced ? '✓ Balanced' : '✗ Out of balance'}
      </div>
    </div>
  );
}
