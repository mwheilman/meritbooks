'use client';

import { useEffect, useMemo, useState } from 'react';
import { Button, Field, InlineNotice, Select, Tabs, useQuery } from '@meritbooks/merit-ui';
import { useAuth } from '@clerk/nextjs';
import { PageHeader } from '@/components/ui';
import { useActiveCompany } from '@/lib/hooks/use-active-company';
import { ChecksClient } from './checks-client';
import { PrintTab } from './print-tab';
import { RegisterTab } from './register-tab';
import { PositivePayTab } from './positive-pay-tab';
import { StockTab } from './stock-tab';
import { defaultCheckAccountId } from '@/lib/ap/checks/check-accounts';
import { accountLabel, type AccountsResponse } from './checks-types';
import s from './checks.module.css';

type Tab = 'print' | 'register' | 'positive' | 'stock' | 'payrun';
const PANEL = 'checks-panel';

/**
 * /checks — the check processor (FPB-check-processing §4). Home = "N checks ready to print";
 * then the register, positive pay, check stock, and the existing pay run (queue → approve →
 * release). Everything is per bank account of the active company.
 */
export function CheckProcessor() {
  const { userId } = useAuth();
  const { activeCompany, activeCompanyId } = useActiveCompany();
  const [tab, setTab] = useState<Tab>('print');
  const [refresh, setRefresh] = useState(0);
  const { data, error, isLoading, refetch } = useQuery<AccountsResponse>(
    '/api/ap/checks/accounts',
    { location_id: activeCompanyId ?? undefined },
    { key: String(refresh), scope: false },
  );
  const accounts = useMemo(() => data?.accounts ?? [], [data]);
  const [accountId, setAccountId] = useState<string | null>(null);

  useEffect(() => {
    if (!accounts.length) { setAccountId(null); return; }
    // Open on the account with a check-stock profile, else the first checking account.
    if (!accountId || !accounts.some((a) => a.id === accountId)) setAccountId(defaultCheckAccountId(accounts));
  }, [accounts, accountId]);

  const account = accounts.find((a) => a.id === accountId) ?? null;
  const changed = () => { setRefresh((n) => n + 1); };

  const companyName = activeCompany?.name ?? 'this company';

  return (
    <div>
      <PageHeader
        eyebrow={['Payables', 'Checks']}
        title="Checks"
        description={`Print released check payments on blank stock, keep the register, void, and send positive pay for ${companyName}.`}
      />

      <div className={s.bar}>
        <Field label="Bank account" className={s.acct}>
          <Select
            value={accountId ?? ''}
            onChange={(e) => setAccountId(e.target.value || null)}
            disabled={!accounts.length}
          >
            {accounts.length === 0 && <option value="">No checking accounts</option>}
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {accountLabel(a)} · next #{a.nextNumber}
              </option>
            ))}
          </Select>
        </Field>
        <div className={s.grow} />
        {account && (
          <span className="t-cap">
            {account.outstandingCount} outstanding check{account.outstandingCount === 1 ? '' : 's'} on this account
          </span>
        )}
      </div>

      <Tabs<Tab>
        className={s.tabs}
        aria-label="Check processing"
        value={tab}
        onChange={setTab}
        items={[
          { value: 'print', label: 'Print checks', panelId: PANEL },
          { value: 'register', label: 'Register', count: account ? account.outstandingCount : undefined, panelId: PANEL },
          { value: 'positive', label: 'Positive pay', panelId: PANEL },
          { value: 'stock', label: 'Check stock', panelId: PANEL },
          { value: 'payrun', label: 'Pay run', panelId: PANEL },
        ]}
      />

      <div id={PANEL} role="tabpanel">
        {tab === 'payrun' ? (
          <ChecksClient embedded />
        ) : isLoading && !data ? (
          <div className="wg-loading" style={{ height: 240 }} aria-busy="true"><span className="bar-l" style={{ width: '60%' }} /></div>
        ) : error ? (
          <InlineNotice tone="neg" title="Couldn't load bank accounts.">
            {error} <Button variant="quiet" onClick={() => void refetch()}>Try again</Button>
          </InlineNotice>
        ) : !account ? (
          <div className={`${s.surface} ${s.state}`}>
            <h2 className="t-section">No checking account for {companyName}</h2>
            <p>
              Checks are drawn on a checking or operating account. Savings, credit card, loan, mortgage, retirement (401k,
              IRA) and HSA accounts are not listed. Connect or add a checking account under Banking, then come back to set
              up check stock.
            </p>
          </div>
        ) : tab === 'print' ? (
          <PrintTab account={account} mail={data?.mail ?? null} userId={userId ?? null} onChanged={changed} onSetup={() => setTab('stock')} />
        ) : tab === 'register' ? (
          <RegisterTab account={account} userId={userId ?? null} onChanged={changed} />
        ) : tab === 'positive' ? (
          <PositivePayTab account={account} userId={userId ?? null} onSetup={() => setTab('stock')} />
        ) : (
          <StockTab account={account} userId={userId ?? null} onChanged={changed} />
        )}
      </div>
    </div>
  );
}
