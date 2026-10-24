'use client';

import { useState } from 'react';
import { Button, Field, InlineNotice, Input, Seg, toast, useQuery } from '@meritbooks/merit-ui';
import { POSITIVE_PAY_FORMATS } from '@/lib/ap/checks/positive-pay';
import { accountLabel, postForFile, usd, shortDate, todayLocal, who, type CheckAccount, type PositivePayResponse } from './checks-types';
import s from './checks.module.css';

type Mode = 'SINCE_LAST' | 'RANGE';

export interface PositivePayTabProps {
  account: CheckAccount;
  userId: string | null;
  onSetup: () => void;
}

/** Positive pay (FPB §4.3): the next file's counts, download in the bank's format, history. */
export function PositivePayTab({ account, userId, onSetup }: PositivePayTabProps) {
  const [refresh, setRefresh] = useState(0);
  const { data, error, isLoading, refetch } = useQuery<PositivePayResponse>('/api/ap/checks/positive-pay', { bank_account_id: account.id }, { key: String(refresh), scope: false });
  const [mode, setMode] = useState<Mode>('SINCE_LAST');
  const [from, setFrom] = useState('');
  const [through, setThrough] = useState(todayLocal());
  const [busy, setBusy] = useState(false);

  const fmt = POSITIVE_PAY_FORMATS.find((f) => f.value === (data?.next.format ?? 'GENERIC_CSV'));
  const next = data?.next;
  const nothingNew = mode === 'SINCE_LAST' && next && next.issueCount + next.voidCount === 0;
  const rangeBad = mode === 'RANGE' && (!from || !through || from > through);

  const download = async () => {
    setBusy(true);
    try {
      const h = await postForFile('/api/ap/checks/positive-pay', { bankAccountId: account.id, mode, from: mode === 'RANGE' ? from : null, through: mode === 'RANGE' ? through : null }, 'positive-pay.csv');
      toast(`Positive-pay file downloaded: ${h.get('X-Positive-Pay-Issues') ?? 0} issue(s), ${h.get('X-Positive-Pay-Voids') ?? 0} void(s). Upload it to your bank before its cutoff.`);
      setRefresh((n) => n + 1);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not generate the file.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      {!account.hasMicr && (
        <div className={s.notice}>
          <InlineNotice tone="warn" title="Add the account number first.">
            The positive-pay file carries the full account number from the check stock settings.{' '}
            <Button variant="quiet" onClick={onSetup}>Open check stock</Button>
          </InlineNotice>
        </div>
      )}

      <div className={s.cols}>
        <section className={s.sec} aria-labelledby="pp-next">
          <h2 id="pp-next" className="t-head">Next file for {accountLabel(account)}</h2>
          <p className="t-cap" style={{ margin: '4px 0 12px' }}>
            Format: {fmt?.label ?? 'Generic CSV'} — {fmt?.help} Change it under Check stock.
          </p>
          <Seg<Mode>
            aria-label="Which checks"
            value={mode}
            onChange={setMode}
            items={[{ value: 'SINCE_LAST', label: 'Since the last file' }, { value: 'RANGE', label: 'Date range' }]}
          />
          {mode === 'RANGE' && (
            <div className={s.grid2} style={{ marginTop: 12 }}>
              <Field label="From"><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
              <Field label="Through"><Input type="date" value={through} onChange={(e) => setThrough(e.target.value)} /></Field>
            </div>
          )}
          {isLoading && !data ? (
            <div className="wg-loading" style={{ height: 80, marginTop: 12 }} aria-busy="true"><span className="bar-l" style={{ width: '40%' }} /></div>
          ) : error ? (
            <p className={s.blocked} role="alert">Couldn&apos;t load positive pay. {error} <Button variant="quiet" onClick={() => void refetch()}>Try again</Button></p>
          ) : next && mode === 'SINCE_LAST' ? (
            <div className={s.strip} style={{ marginTop: 12 }}>
              <div className={s.cell}>
                <span className={s.cellL}>Issued checks</span>
                <span className={s.cellV}>{next.issueCount}</span>
                <span className={s.cellS}>{usd(next.issueTotalCents)}</span>
              </div>
              <div className={s.cell}>
                <span className={s.cellL}>Voids</span>
                <span className={s.cellV}>{next.voidCount}</span>
                <span className={s.cellS}>{usd(next.voidTotalCents)} · voided and spoiled</span>
              </div>
            </div>
          ) : null}
          <div className="btn-row" style={{ marginTop: 12 }}>
            <Button variant="primary" onClick={() => void download()} disabled={busy || !account.hasMicr || !!nothingNew || rangeBad}>
              {busy ? 'Building…' : 'Download file'}
            </Button>
            {nothingNew && <span className="t-cap">Nothing new since the last file.</span>}
          </div>
          <p className="t-cap" style={{ marginTop: 12 }}>
            The file includes the full account number, so downloading it is logged. Voided and spoiled checks go as void records so a lost or stolen
            check is refused at the bank.
          </p>
        </section>

        <section className={s.sec} aria-labelledby="pp-hist">
          <h2 id="pp-hist" className="t-head">Files sent</h2>
          {data && data.history.length === 0 ? (
            <p className="t-cap" style={{ marginTop: 8 }}>No positive-pay files yet for this account.</p>
          ) : (
            <table className="tbl tbl-fs" style={{ marginTop: 8 }}>
              <thead>
                <tr><th>Date</th><th>File</th><th className="n">Issues</th><th className="n">Voids</th><th>By</th></tr>
              </thead>
              <tbody>
                {(data?.history ?? []).map((h) => (
                  <tr key={h.id}>
                    <td>{shortDate(h.created_at)}</td>
                    <td>{h.file_name}</td>
                    <td className="n">{h.issue_count} · {usd(h.issue_total_cents)}</td>
                    <td className="n">{h.void_count}</td>
                    <td>{who(data?.names ?? {}, h.generated_by, userId)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>
    </div>
  );
}
