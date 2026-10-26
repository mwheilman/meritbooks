'use client';

import { usePeekDetail } from '@/components/hover-peek';
import { formatMoney } from '@meritbooks/shared';
import s from './bills.module.css';

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
  if (loading && !data) {
    return (
      <div className={`wg-loading ${s.peekState}`} aria-busy="true">
        <span className="bar-l" style={{ width: '60%' }} aria-hidden="true" />
        <span className="bar-l" style={{ width: '85%' }} aria-hidden="true" />
        <span className="bar-l" style={{ width: '40%' }} aria-hidden="true" />
        <span className="sr" role="status">Loading the bill preview</span>
      </div>
    );
  }
  if (!data) return <div className={s.peekState}><p className="t-cap">Preview unavailable — open the bill to see it.</p></div>;

  const shown = data.lines.slice(0, 6);
  const more = data.lines.length - shown.length;
  const vendorName = data.vendor?.display_name ?? data.vendor?.name ?? 'Vendor';

  return (
    <div className={s.peek}>
      <div className={s.peekHead}>
        <div style={{ minWidth: 0 }}>
          <span className="l1">{vendorName}</span>
          <span className="l2">Vendor bill{data.location ? ` · ${data.location.short_code}` : ''}</span>
        </div>
        <div className="n">
          <span className="l1 tnum">{data.bill_number ?? '—'}</span>
          <span className="l2 tnum">{data.bill_date}</span>
        </div>
      </div>
      <div className={`t-cap ${s.peekDue}`}>
        Due <span className="ink tnum">{data.due_date}</span>
      </div>
      <table className={s.peekLines}>
        <tbody>
          {shown.map((l) => (
            <tr key={l.id}>
              <td className="ink-2">{l.description ?? 'Line'}</td>
              <td className="n">{formatMoney(l.amount_cents)}</td>
            </tr>
          ))}
          {more > 0 && <tr><td className="t-cap" colSpan={2}>+ {more} more line{more > 1 ? 's' : ''}</td></tr>}
        </tbody>
      </table>
      <dl className={s.peekTotals}>
        <dt className="ink-2">Subtotal</dt><dd>{formatMoney(data.subtotal_cents)}</dd>
        {data.tax_cents > 0 && <><dt className="ink-2">Tax</dt><dd>{formatMoney(data.tax_cents)}</dd></>}
        <dt className={s.strong}>Total</dt><dd className={s.strong}>{formatMoney(data.total_cents)}</dd>
        <dt className={s.strong}>Balance due</dt><dd className={s.strong}>{formatMoney(data.balance_cents)}</dd>
      </dl>
    </div>
  );
}
