'use client';

import { usePeekDetail } from '@/components/hover-peek';
import { formatMoney } from '@meritbooks/shared';
import { cx } from '@meritbooks/merit-ui';
import { InvoiceStatus } from './invoice-status';
import s from './invoices.module.css';

interface InvLine { id: string; description: string; quantity: number; unitPriceCents: number; amountCents: number; }
interface InvDetail {
  invoiceNumber: string; invoiceDate: string; dueDate: string; status: string;
  subtotalCents: number; taxCents: number; totalCents: number; balanceCents: number;
  customerName: string; locationName: string; lines: InvLine[];
  /** Same derived status as the list row + drawer (lib/invoices/display-status.ts). */
  displayStatus?: string; displayStatusHint?: string | null; daysOverdue?: number;
}

/** A miniature of the actual invoice document for the hover-peek. */
export function InvoicePeek({ invoiceId }: { invoiceId: string }) {
  const { data, loading } = usePeekDetail<InvDetail>(`/api/invoices/${invoiceId}`);

  if (loading && !data) {
    return (
      <div className={s.peekState} aria-busy="true">
        <span className="mb-skel" style={{ width: '60%' }} aria-hidden="true" />
        <span className="mb-skel" style={{ width: '80%' }} aria-hidden="true" />
        <span className="mb-skel" style={{ width: '40%' }} aria-hidden="true" />
        <span className="sr" role="status">Loading the preview</span>
      </div>
    );
  }
  if (!data) {
    return (
      <div className={s.peekState}>
        <span className="t-head">Preview unavailable</span>
        <span className="t-cap">Open the invoice to see it in full.</span>
      </div>
    );
  }

  const shown = (data.lines ?? []).slice(0, 6);
  const more = (data.lines?.length ?? 0) - shown.length;

  return (
    <div className={s.peek}>
      <div className={s.peekTop}>
        <div>
          <b>{data.locationName || 'Company'}</b>
          <span>Invoice</span>
        </div>
        <div style={{ textAlign: 'right' }}>
          <b className="tnum">{data.invoiceNumber}</b>
          <span className="tnum">{data.invoiceDate}</span>
        </div>
      </div>
      <div className={s.peekBill}>
        <span>Bill to <b>{data.customerName || '--'}</b></span>
        <span className="tnum">Due {data.dueDate}</span>
      </div>
      <div className={s.peekBill}>
        <InvoiceStatus status={data.displayStatus ?? data.status} daysOverdue={data.daysOverdue} hint={data.displayStatusHint} />
      </div>
      <table className={s.peekLines}>
        <tbody>
          {shown.map((l) => (
            <tr key={l.id}>
              <td>{l.description}</td>
              <td>{formatMoney(l.amountCents)}</td>
            </tr>
          ))}
          {more > 0 && (
            <tr><td className="t-cap" colSpan={2}>+ {more} more line{more > 1 ? 's' : ''}</td></tr>
          )}
        </tbody>
      </table>
      <div className={s.peekTotals}>
        <Row label="Subtotal" value={formatMoney(data.subtotalCents)} />
        {data.taxCents > 0 && <Row label="Tax" value={formatMoney(data.taxCents)} />}
        <Row label="Total" value={formatMoney(data.totalCents)} bold />
        <Row label="Balance due" value={formatMoney(data.balanceCents)} bold />
      </div>
    </div>
  );
}

function Row({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <div className={cx(bold && s.peekStrong)}>
      <span>{label}</span>
      <span>{value}</span>
    </div>
  );
}
