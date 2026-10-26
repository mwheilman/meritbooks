'use client';

import { usePeekDetail } from '@/components/hover-peek';
import { formatMoney } from '@meritbooks/shared';
import { Status } from '@meritbooks/merit-ui';
import s from './je.module.css';

interface JELine { id: string; accountNumber: string; accountName: string; debitCents: number; creditCents: number; }
interface JEDetail {
  entryNumber: string; entryDate: string; memo: string | null; status: string;
  totalDebitsCents: number; totalCreditsCents: number; balanced: boolean; lines: JELine[];
}

/** A mini debit/credit ledger view — the natural way to read a JE at a glance. */
export function JournalEntryPeek({ entryId }: { entryId: string }) {
  const { data, loading } = usePeekDetail<JEDetail>(`/api/journal-entries/${entryId}`);

  if (loading && !data) {
    return (
      <div className={`wg-loading ${s.peekState}`} aria-busy="true">
        <span className="bar-l" style={{ width: '50%' }} aria-hidden="true" />
        <span className="bar-l" style={{ width: '85%' }} aria-hidden="true" />
        <span className="bar-l" style={{ width: '70%' }} aria-hidden="true" />
        <span className="sr" role="status">Loading the entry preview</span>
      </div>
    );
  }
  if (!data) return <div className={s.peekState}><p className="t-cap">Preview unavailable — open the entry to see it.</p></div>;

  const shown = data.lines.slice(0, 7);
  const more = data.lines.length - shown.length;

  return (
    <div className={s.peek}>
      <div className={s.peekHead}>
        <div style={{ minWidth: 0 }}>
          <span className="l1 tnum">{data.entryNumber}</span>
          {data.memo && <span className="l2">{data.memo}</span>}
        </div>
        <span className="t-cap tnum">{data.entryDate}</span>
      </div>
      <table className={s.peekLines}>
        <thead>
          <tr>
            <th scope="col">Account</th>
            <th scope="col">Debit</th>
            <th scope="col">Credit</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((l) => (
            <tr key={l.id}>
              <td title={`${l.accountNumber} ${l.accountName}`}>
                <span className="code">{l.accountNumber}</span>
                <span className="ink-2">{l.accountName}</span>
              </td>
              <td className="n">{l.debitCents ? formatMoney(l.debitCents) : ''}</td>
              <td className="n">{l.creditCents ? formatMoney(l.creditCents) : ''}</td>
            </tr>
          ))}
          {more > 0 && <tr><td className="t-cap" colSpan={3}>+ {more} more line{more > 1 ? 's' : ''}</td></tr>}
        </tbody>
        <tfoot>
          <tr>
            <td>Totals</td>
            <td className="n">{formatMoney(data.totalDebitsCents)}</td>
            <td className="n">{formatMoney(data.totalCreditsCents)}</td>
          </tr>
        </tfoot>
      </table>
      <div className={s.peekFoot}>
        {data.balanced ? <Status kind="ready">Balanced</Status> : <Status kind="blocked">Out of balance</Status>}
      </div>
    </div>
  );
}
