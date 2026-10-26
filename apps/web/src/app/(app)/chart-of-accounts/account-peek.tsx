'use client';
import { usePeekDetail } from '@/components/hover-peek';
import { formatMoney } from '@meritbooks/shared';
import { Icon, Tag } from '@meritbooks/merit-ui';
import s from './coa.module.css';

interface AcctDetail {
  accountNumber: string; name: string; accountType: string; accountSubType: string | null;
  isControl: boolean; naturalBalanceCents: number; normalBalance: string; activityCount: number;
  recentActivity: Array<{ id: string; entryNumber: string; entryDate: string; debitCents: number; creditCents: number }>;
}

export function AccountPeek({ accountId }: { accountId: string }) {
  const { data, loading } = usePeekDetail<AcctDetail>(`/api/accounts/${accountId}`);
  if (loading && !data) {
    return (
      <div className={`wg-loading ${s.peekState}`} aria-busy="true">
        <span className="bar-l" style={{ width: '60%' }} aria-hidden="true" />
        <span className="bar-l" style={{ width: '85%' }} aria-hidden="true" />
        <span className="bar-l" style={{ width: '40%' }} aria-hidden="true" />
        <span className="sr" role="status">Loading the account preview</span>
      </div>
    );
  }
  if (!data) return <div className={s.peekState}><p className="t-cap">Preview unavailable — open the account to see it.</p></div>;
  return (
    <div className={s.peek}>
      <div className={s.peekHead}>
        <span className="l1"><span className="code">{data.accountNumber}</span>{data.name}</span>
        <span className="l2">
          {data.accountType}{data.accountSubType ? ` · ${data.accountSubType}` : ''}
        </span>
        {data.isControl && <Tag tone="warn" title="Control account — no direct posting" style={{ marginTop: 4 }}><Icon name="lock" />Control</Tag>}
      </div>
      <div className={s.peekBal}>
        <span className="t-cap">Balance ({data.normalBalance === 'CREDIT' ? 'credit' : 'debit'})</span>
        <b>{formatMoney(data.naturalBalanceCents)}</b>
      </div>
      {data.recentActivity.length > 0 && (
        <>
          <div className="t-cap" style={{ marginTop: 12 }}>Recent activity</div>
          <ul className={s.peekList}>
            {data.recentActivity.slice(0, 4).map((e) => (
              <li key={e.id + e.entryNumber}>
                <span className="tnum mb-trunc">{e.entryNumber}</span>
                <span className="t-cap tnum">{e.entryDate}</span>
                <span className="n">{formatMoney(e.debitCents || e.creditCents)}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
