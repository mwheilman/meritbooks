'use client';

import { useEffect, useState } from 'react';
import { Button, Dialog, Seg, Tag } from '@meritbooks/merit-ui';
import { formatMoney } from '@meritbooks/shared';
import { ListPager } from '@/components/ui/list-pager';
import s from './coa.module.css';

// Full general-ledger detail for a single account, reusing the existing
// read route (/api/reports/gl-detail). Opened from the Chart of Accounts
// grouped view as the per-account "drill to GL detail".

interface GlTxn {
  id: string;
  entryNumber: string;
  entryDate: string;
  sourceModule: string;
  entryMemo: string | null;
  lineMemo: string | null;
  debitCents: number;
  creditCents: number;
  locationCode: string;
}

interface GlDetailResponse {
  data: GlTxn[];
  summary: { totalDebitCents: number; totalCreditCents: number; netCents: number };
  pagination: { page: number; per_page: number; total: number; total_pages: number };
}

const SOURCE_LABEL: Record<string, string> = {
  MANUAL: 'Manual',
  AR: 'AR',
  AP: 'AP',
  CASH_MGMT: 'Cash',
  PAYROLL: 'Payroll',
  FIXED_ASSETS: 'Fixed assets',
  BANK_FEED: 'Bank feed',
  SYSTEM: 'System',
};

type Range = 'ytd' | 'period';

export function GlDetailModal({
  accountId,
  accountNumber,
  accountName,
  startDate,
  endDate,
  locationId,
  onClose,
  periodStartDate,
  periodEndDate,
  periodLabel,
}: {
  accountId: string;
  accountNumber: string;
  accountName: string;
  startDate: string;
  endDate: string;
  /** Active-company scope; omit/'all' for consolidated. */
  locationId?: string | null;
  onClose: () => void;
  /** Optional single-month range; when given, a toggle switches between it and start–end. */
  periodStartDate?: string;
  periodEndDate?: string;
  periodLabel?: string;
}) {
  const [data, setData] = useState<GlDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [page, setPage] = useState(1);
  const [range, setRange] = useState<Range>('ytd');
  const [attempt, setAttempt] = useState(0);

  const hasPeriod = !!periodStartDate && !!periodEndDate;
  const from = range === 'period' && hasPeriod ? periodStartDate! : startDate;
  const to = range === 'period' && hasPeriod ? periodEndDate! : endDate;

  useEffect(() => { setPage(1); }, [range]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError('');
    const params = new URLSearchParams();
    params.set('account_id', accountId);
    params.set('start_date', from);
    params.set('end_date', to);
    if (locationId && locationId !== 'all') params.set('location_id', locationId);
    params.set('page', String(page));
    params.set('per_page', '50');

    fetch(`/api/reports/gl-detail?${params}`)
      .then((r) => r.json())
      .then((d) => {
        if (!alive) return;
        if (d?.error) { setError(d.error); setData(null); }
        else setData(d);
        setLoading(false);
      })
      .catch((e) => { if (alive) { setError(e.message); setLoading(false); } });
    return () => { alive = false; };
  }, [accountId, from, to, locationId, page, attempt]);

  const txns = data?.data ?? [];
  const summary = data?.summary;
  const pagination = data?.pagination;

  return (
    <Dialog
      open
      onClose={onClose}
      width={960}
      title={<>GL detail · <span className="tnum">{accountNumber}</span> {accountName}</>}
      footNote={pagination ? `${pagination.total} line${pagination.total === 1 ? '' : 's'} · posted entries only` : 'Posted entries only'}
      actions={<Button onClick={onClose}>Close</Button>}
    >
      <div className={s.glHead}>
        <div>
          <span className="t-cap tnum">{from} → {to}</span>
          {hasPeriod && (
            <div style={{ marginTop: 8 }}>
              <Seg<Range>
                aria-label="GL detail range"
                value={range}
                onChange={setRange}
                items={[
                  { value: 'ytd', label: 'Year to date' },
                  { value: 'period', label: periodLabel ?? 'Period' },
                ]}
              />
            </div>
          )}
        </div>
        {summary && (
          <dl className={`kv ${s.glKv}`}>
            <dt>Debits on this page</dt><dd>{formatMoney(summary.totalDebitCents)}</dd>
            <dt>Credits on this page</dt><dd>{formatMoney(summary.totalCreditCents)}</dd>
            <dt>Net (debit − credit)</dt><dd>{formatMoney(summary.netCents)}</dd>
          </dl>
        )}
      </div>

      {loading ? (
        <div className={`wg-loading ${s.glState}`} aria-busy="true">
          <span className="bar-l" style={{ width: '80%' }} aria-hidden="true" />
          <span className="bar-l" style={{ width: '65%' }} aria-hidden="true" />
          <span className="bar-l" style={{ width: '72%' }} aria-hidden="true" />
          <span className="t-cap" role="status">Loading ledger lines…</span>
        </div>
      ) : error ? (
        <div className={`wg-state ${s.glState}`} role="alert">
          <Tag tone="neg">Not loaded</Tag>
          <span className="t-head">The ledger didn&apos;t load</span>
          <p>{error}</p>
          <Button onClick={() => setAttempt((n) => n + 1)}>Try again</Button>
        </div>
      ) : txns.length === 0 ? (
        <div className={`wg-state ${s.glState}`}>
          <span className="wg-empty-mark" aria-hidden="true" />
          <span className="t-head">No posted activity in this range</span>
          <p>{hasPeriod && range === 'period' ? 'Switch to Year to date, or pick another month on the page.' : 'Pick another period on the page, or check the company in the header.'}</p>
        </div>
      ) : (
        <>
          <div className={s.glWrap}>
            <table className="tbl tbl-q tbl-q--compact tbl-q--flush" aria-label={`GL detail for ${accountNumber}`}>
              <colgroup>
                <col style={{ width: 112 }} />
                <col style={{ width: 120 }} />
                <col style={{ width: 112 }} />
                <col />
                <col style={{ width: 72 }} />
                <col style={{ width: 128 }} />
                <col style={{ width: 128 }} />
              </colgroup>
              <thead>
                <tr>
                  <th scope="col">Date</th>
                  <th scope="col">Entry #</th>
                  <th scope="col">Source</th>
                  <th scope="col">Memo</th>
                  <th scope="col">Co.</th>
                  <th scope="col" className="n">Debit</th>
                  <th scope="col" className="n">Credit</th>
                </tr>
              </thead>
              <tbody>
                {txns.map((t) => (
                  <tr key={t.id} className="q-row">
                    <td className="tnum ink-2">{t.entryDate}</td>
                    <td className="tnum">{t.entryNumber}</td>
                    <td><Tag tone={t.sourceModule && t.sourceModule !== 'MANUAL' ? 'ai' : 'default'}>{SOURCE_LABEL[t.sourceModule] ?? (t.sourceModule || 'Manual')}</Tag></td>
                    <td title={t.lineMemo ?? t.entryMemo ?? ''}>{t.lineMemo || t.entryMemo || <span className="ink-3">—</span>}</td>
                    <td className="ink-2">{t.locationCode}</td>
                    <td className="n">{t.debitCents > 0 ? formatMoney(t.debitCents) : ''}</td>
                    <td className="n">{t.creditCents > 0 ? formatMoney(t.creditCents) : ''}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={5}>Page totals</td>
                  <td className="n">{formatMoney(summary?.totalDebitCents ?? 0)}</td>
                  <td className="n">{formatMoney(summary?.totalCreditCents ?? 0)}</td>
                </tr>
              </tfoot>
            </table>
          </div>

          {pagination && (
            <ListPager
              page={pagination.page}
              perPage={pagination.per_page}
              total={pagination.total}
              noun="lines"
              onPageChange={setPage}
              isLoading={loading}
            />
          )}
        </>
      )}
    </Dialog>
  );
}
