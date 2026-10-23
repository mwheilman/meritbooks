'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Button,
  ConfirmDialog,
  Field,
  InlineNotice,
  Input,
  QueueTable,
  Tag,
  money,
  toast,
  useQuery,
  type QueueColumn,
} from '@meritbooks/merit-ui';
import { accountLabel, postForFile, shortDate, todayLocal, who, type AccountsResponse, type CheckAccount, type ReadyCheck, type ReadyResponse } from './checks-types';
import s from './checks.module.css';

export interface PrintTabProps {
  account: CheckAccount;
  mail: AccountsResponse['mail'] | null;
  userId: string | null;
  onChanged: () => void;
  onSetup: () => void;
}

/**
 * Print checks (FPB §4.1): "N checks ready to print", select, alignment test, print. The
 * numbers shown come from the account's sequence; the print request carries the expected
 * first number so a stale screen can never print a different range than it showed.
 */
export function PrintTab({ account, mail, userId, onChanged, onSetup }: PrintTabProps) {
  const [refresh, setRefresh] = useState(0);
  const { data, error, isLoading, refetch } = useQuery<ReadyResponse>(
    '/api/ap/checks/ready',
    { bank_account_id: account.id },
    { key: String(refresh), scope: false },
  );
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [checkDate, setCheckDate] = useState(todayLocal());
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState<'print' | 'align' | null>(null);

  const checks = useMemo(() => data?.checks ?? [], [data]);
  const printable = useMemo(() => checks.filter((c) => c.printable), [checks]);

  // Default selection: everything this user may print.
  useEffect(() => {
    setSelected(new Set(printable.map((c) => c.key)));
  }, [printable]);

  const chosen = useMemo(() => printable.filter((c) => selected.has(c.key)), [printable, selected]);
  const chosenCents = chosen.reduce((n, c) => n + c.amountCents, 0);
  const first = data?.nextNumber ?? account.nextNumber;
  const last = first + Math.max(chosen.length, 1) - 1;
  const range = chosen.length <= 1 ? `#${first}` : `#${first}–${last}`;

  const alignment = useCallback(async () => {
    const tab = window.open('', '_blank');
    setBusy('align');
    try {
      await postForFile('/api/ap/checks/alignment', { bankAccountId: account.id }, 'check-alignment-test.pdf', tab);
      toast('Alignment test ready. Print it on plain paper at 100% and hold it against a sheet of check stock.');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not build the alignment test.');
    } finally {
      setBusy(null);
    }
  }, [account.id]);

  const print = useCallback(async () => {
    const tab = window.open('', '_blank');
    setBusy('print');
    try {
      const headers = await postForFile(
        '/api/ap/checks/print',
        {
          bankAccountId: account.id,
          billPaymentIds: chosen.flatMap((c) => c.payments.map((p) => p.billPaymentId)),
          checkDate,
          expectedFirstNumber: first,
        },
        `checks-${first}.pdf`,
        tab,
      );
      const f = headers.get('X-Check-First');
      const l = headers.get('X-Check-Last');
      toast(`Printed check${f === l ? ` ${f}` : `s ${f}–${l}`}. If a sheet jams, spoil it from the Register and reprint.`);
      setRefresh((n) => n + 1);
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not print the checks.');
      void refetch();
      throw e;
    } finally {
      setBusy(null);
    }
  }, [account.id, chosen, checkDate, first, onChanged, refetch]);

  const names = data?.names ?? {};
  const columns = useMemo<QueueColumn<ReadyCheck>[]>(
    () => [
      {
        id: 'payee',
        header: 'Pay to',
        cell: (c) => (
          <>
            <span className="l1">{c.payeeName}</span>
            <span className={`l2 ${c.printable ? '' : s.blocked}`}>
              {c.printable ? (c.payeeAddress ? c.payeeAddress.split('\n').join(', ') : 'No mailing address on file') : c.blockedReason}
            </span>
          </>
        ),
      },
      {
        id: 'bills',
        header: 'Bills paid',
        width: 220,
        cell: (c) => (
          <>
            <span className="l1">{c.payments.map((p) => p.billNumber ?? 'No number').join(', ')}</span>
            <span className="l2">{c.payments.length} bill{c.payments.length === 1 ? '' : 's'}</span>
          </>
        ),
      },
      {
        id: 'released',
        header: 'Released',
        width: 180,
        cell: (c) => (
          <>
            <span className="l1">{who(names, c.payments[0]?.releasedBy, userId)}</span>
            <span className="l2">{shortDate(c.payments[0]?.paymentDate ?? null)}</span>
          </>
        ),
      },
      { id: 'amount', header: 'Amount', width: 130, numeric: true, cell: (c) => <span className="tnum">{money(c.amountCents)}</span> },
    ],
    [names, userId],
  );

  const blocked = checks.length - printable.length;

  return (
    <div>
      {!account.hasMicr && (
        <div className={s.notice}>
          <InlineNotice tone="warn" title="Add the bank numbers before printing.">
            Checks need this account&apos;s routing and account numbers for the MICR line at the bottom.{' '}
            <Button variant="quiet" onClick={onSetup}>Open check stock</Button>
          </InlineNotice>
        </div>
      )}
      {account.hasMicr && !account.hasSignature && (
        <div className={s.notice}>
          <InlineNotice tone="info" title="No signature on file.">
            Checks print with a blank signature line to sign by hand. Upload a signature under Check stock to print it.
          </InlineNotice>
        </div>
      )}

      <div className={s.hero}>
        <span className={s.heroCount}>
          {data ? `${data.totals.count} check${data.totals.count === 1 ? '' : 's'} ready to print` : 'Checks ready to print'}
        </span>
        {data && <span className={`${s.heroSub} tnum`}>{money(data.totals.amountCents)} · {accountLabel(account)} · next number {first}</span>}
      </div>

      <div className={s.bar}>
        <Field label="Check date">
          <Input type="date" value={checkDate} onChange={(e) => setCheckDate(e.target.value)} max="2099-12-31" />
        </Field>
        <div className={s.grow} />
        <Button onClick={() => void alignment()} disabled={busy !== null} icon="file-text">
          {busy === 'align' ? 'Building…' : 'Print alignment test'}
        </Button>
        <Button
          variant="primary"
          icon="file-text"
          disabled={chosen.length === 0 || busy !== null || !account.hasMicr || !checkDate}
          onClick={() => setConfirm(true)}
          count={chosen.length || undefined}
        >
          {busy === 'print' ? 'Printing…' : `Print ${chosen.length === 1 ? 'check' : 'checks'} ${chosen.length ? range : ''}`}
        </Button>
        <span title={mail?.note ?? 'Not configured'}>
          <Button disabled aria-describedby="mail-note">Mail with a service</Button>
        </span>
      </div>
      <p id="mail-note" className="t-cap" style={{ marginTop: -8, marginBottom: 16 }}>
        Mail with a service: {mail?.note ?? 'Not configured.'}
      </p>

      {data?.securityHold && (
        <InlineNotice tone="neg" title="You can't print checks on this account yet">
          {data.securityHold.reason}
        </InlineNotice>
      )}
      {data && data.excluded.vendorHold > 0 && (
        <InlineNotice tone="warn" title={`${data.excluded.vendorHold} payment${data.excluded.vendorHold === 1 ? ' is' : 's are'} on hold`}>
          These were released, but the vendor has since gone on hold (a bank-detail change waiting for a call-back, or a compliance lapse). They stay off the print run until the hold clears — the reason is on each line below.
        </InlineNotice>
      )}

      <div className={s.surface}>
        {isLoading && !data ? (
          <div className="wg-loading" style={{ height: 200 }} aria-busy="true"><span className="bar-l" style={{ width: '50%' }} /></div>
        ) : error ? (
          <div className={s.state} role="alert">
            <p>Couldn&apos;t load the checks ready to print. {error}</p>
            <Button onClick={() => void refetch()}>Try again</Button>
          </div>
        ) : checks.length === 0 ? (
          <div className={s.state}>
            <h2 className="t-section">Nothing to print</h2>
            <p>
              Released check payments drawn on {accountLabel(account)} appear here. Queue, approve and release bills under Pay run.
              {data && (data.excluded.handwritten > 0 || data.excluded.outsidePayRun > 0) && (
                <> {data.excluded.handwritten > 0 && `${data.excluded.handwritten} payment(s) were recorded as handwritten checks. `}
                  {data.excluded.outsidePayRun > 0 && `${data.excluded.outsidePayRun} check payment(s) were recorded outside the pay run and can't be printed here.`}</>
              )}
            </p>
          </div>
        ) : (
          <>
            <div className={s.toolbar}>
              <span className="t-cap tnum">
                {chosen.length} of {printable.length} selected · {money(chosenCents)}
                {blocked > 0 && ` · ${blocked} you can't print (someone else has to)`}
              </span>
              <div className={s.grow} />
              <Button variant="quiet" onClick={() => setSelected(new Set(printable.map((c) => c.key)))}>Select all</Button>
              <Button variant="quiet" onClick={() => setSelected(new Set())}>Clear</Button>
            </div>
            <QueueTable<ReadyCheck>
              aria-label={`Checks ready to print on ${accountLabel(account)}`}
              columns={columns}
              rows={checks}
              getRowId={(c) => c.key}
              rowState={(c) => ({ attn: !c.printable })}
              selectable
              selected={selected}
              onSelectedChange={(next) => setSelected(new Set(Array.from(next).filter((k) => printable.some((c) => c.key === k))))}
            />
          </>
        )}
      </div>
      {data && data.oneCheckPerBill && <p className="t-cap" style={{ marginTop: 8 }}>This account prints one check per bill.</p>}
      {chosen.some((c) => !c.hasAddress) && (
        <p className="t-cap" style={{ marginTop: 8 }}><Tag tone="warn">Address</Tag> Some payees have no mailing address on file — the window envelope will show only the name.</p>
      )}

      <ConfirmDialog
        open={confirm}
        onClose={() => setConfirm(false)}
        onConfirm={() => print()}
        title={`Print ${chosen.length} check${chosen.length === 1 ? '' : 's'} for ${money(chosenCents)}?`}
        confirmLabel={`Print ${range}`}
        footNote="Numbers are used the moment the PDF is created. A jammed or misprinted sheet is spoiled from the Register and reprinted on the next number."
      >
        <p>
          This uses check number{chosen.length === 1 ? '' : 's'} <b className="tnum">{range.replace('#', '')}</b> on {accountLabel(account)}, dated {shortDate(checkDate)}.
          Load blank check stock, check side up, and print at 100% (no &ldquo;fit to page&rdquo;).
        </p>
      </ConfirmDialog>
    </div>
  );
}
