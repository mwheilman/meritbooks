'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, ButtonLink, ConfirmDialog, Eyebrow, InlineNotice, Keyhints, QueueTable, Radio, Tag, type QueueColumn } from '@meritbooks/merit-ui';
import { PageHeader } from '@/components/ui';
import { addToast } from '@/hooks';
import { api } from '@/lib/api-client';
import { CompanyDrawer } from './company-drawer';
import { ModeBadge, ReadinessStatus, methodSummary, payoutBankText, usd } from './payments-format';
import type { AccountMode, CompanyRow, PaymentsOverviewResponse } from './payments-types';

/**
 * Settings → Payments (FPB-payments-fees §17.3, merit-ui). Every company with its own
 * Stripe account, payout bank, TEST/LIVE badge, accepted methods and who pays each fee.
 * "Live" is only ever the server's verdict (live keys AND a ready account).
 */
export function PaymentsSettings({ initialCompany }: { initialCompany: string | null }) {
  const [data, setData] = useState<PaymentsOverviewResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [openId, setOpenId] = useState<string | null>(initialCompany);
  const [cursor, setCursor] = useState<string | null>(null);
  const [pendingMode, setPendingMode] = useState<AccountMode | null>(null);

  const load = useCallback(async (refresh: boolean) => {
    if (refresh) setRefreshing(true);
    const res = await api.get<PaymentsOverviewResponse>('/api/payments/accounts', refresh ? { refresh: '1' } : undefined);
    if (res.data) {
      setData(res.data);
      setError(null);
      if (refresh) {
        addToast(res.data.refreshedErrors > 0 ? 'error' : 'success', res.data.refreshedErrors > 0 ? `Checked with Stripe · ${res.data.refreshedErrors} account${res.data.refreshedErrors === 1 ? '' : 's'} could not be reached` : 'Checked with Stripe');
      }
    } else {
      setError(res.status === 403 ? 'You do not have access to payment settings.' : res.error?.error || 'Payment settings did not load.');
    }
    setLoading(false);
    setRefreshing(false);
  }, []);

  // Coming back from Stripe (?company=…) → check that company's status straight away.
  useEffect(() => {
    void load(initialCompany !== null);
  }, [load, initialCompany]);

  const companies = useMemo(() => data?.companies ?? [], [data]);
  const open = companies.find((c) => c.locationId === openId) ?? null;

  const counts = useMemo(() => {
    const ready = companies.filter((c) => c.account.readiness === 'ready').length;
    const online = companies.filter((c) => c.acceptsOnline).length;
    return { ready, online, total: companies.length };
  }, [companies]);

  async function applyMode(mode: AccountMode) {
    const res = await api.put<{ ok: boolean }>('/api/payments/settings', { account_mode: mode });
    if (res.error) throw new Error(res.error.error || 'Could not change the account setup.');
    addToast('success', mode === 'single' ? 'Switched to one Stripe account for all companies' : 'Switched to one Stripe account per company');
    await load(false);
  }

  const columns = useMemo<QueueColumn<CompanyRow>[]>(
    () => [
      {
        id: 'company',
        header: 'Company',
        cell: (c) => (
          <>
            <span className="l1">{c.name}</span>
            <span className="l2">{c.acceptsOnline ? 'Customers can pay online' : 'Online payment off'}</span>
          </>
        ),
      },
      {
        id: 'stripe',
        header: 'Stripe account',
        width: 200,
        cell: (c) => (
          <>
            <ReadinessStatus readiness={c.account.readiness} label={c.account.readinessLabel} />
            {c.account.source === 'tenant' && <span className="l2">Shared account</span>}
          </>
        ),
      },
      { id: 'bank', header: 'Deposits to', width: 168, cell: (c) => payoutBankText(c.account) },
      { id: 'mode', header: 'Mode', width: 80, cell: (c) => <ModeBadge badge={c.account.modeBadge} /> },
      { id: 'card', header: 'Card', width: 200, cell: (c) => methodSummary(c.options.cardEnabled, c.options.cardFeePayer) },
      { id: 'ach', header: 'Bank transfer', width: 210, cell: (c) => methodSummary(c.options.achEnabled, c.options.achFeePayer) },
      {
        id: 'act',
        header: <span className="sr">Open</span>,
        width: 104,
        cell: (c) => (
          <Button variant="quiet" onClick={(e) => { e.stopPropagation(); setOpenId(c.locationId); }}>
            {c.account.hasAccount ? 'Manage' : 'Set up'}
          </Button>
        ),
      },
    ],
    [],
  );

  const header = (
    <PageHeader
      eyebrow={['Settings', 'Payments']}
      title="Payments"
      description="Let customers pay invoices online by card or bank transfer. Each company collects into its own Stripe account, so the money lands in that company's bank."
      actions={
        data && data.stripe.state !== 'not_configured' ? (
          <Button onClick={() => void load(true)} disabled={refreshing}>
            {refreshing ? 'Checking with Stripe…' : 'Check status with Stripe'}
          </Button>
        ) : undefined
      }
    />
  );

  if (loading && !data) {
    return (
      <div>
        {header}
        <div className="surface wg-loading mb-state-block" aria-busy="true">
          <span className="bar-l" style={{ width: '64%' }} aria-hidden="true" />
          <span className="bar-l" style={{ width: '48%' }} aria-hidden="true" />
          <span className="bar-l" style={{ width: '56%' }} aria-hidden="true" />
          <span className="t-cap" role="status">Loading payment settings…</span>
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div>
        {header}
        <div className="surface wg-state mb-state-block" role="alert">
          <span className="tag tag--neg">Not loaded</span>
          <span className="t-head">Payment settings didn&rsquo;t load</span>
          <p>{error}</p>
          <Button onClick={() => { setLoading(true); void load(false); }}>Try again</Button>
        </div>
      </div>
    );
  }

  const s = data.stripe;

  return (
    <div className="stack">
      {header}

      {/* 01 // Mode — never "live" unless the server says so. */}
      <section aria-labelledby="pay-mode-h">
        <Eyebrow>{['01', 'Mode']}</Eyebrow>
        <h2 id="pay-mode-h" className="sr">Payment mode</h2>
        <div className="surface" style={{ marginTop: 8, padding: 16 }}>
          {s.state === 'ready' && s.isLive && (
            <div className="row"><Tag tone="pos">LIVE</Tag><span className="ink">Live — customer payments are real money.</span></div>
          )}
          {s.state === 'ready' && !s.isLive && (
            <div className="row"><Tag tone="warn">TEST</Tag><span className="ink">Test mode — no real money moves. Payments go live when the live Stripe keys are added to the server.</span></div>
          )}
          {s.state !== 'ready' && (
            <InlineNotice tone={s.state === 'not_configured' ? 'warn' : 'neg'} title={s.state === 'not_configured' ? 'Online payment is not set up yet.' : 'Online payment is off.'}>
              {s.problem}
            </InlineNotice>
          )}
          {data.can.configure && s.state === 'ready' && (!s.webhookConfigured || !s.connectWebhookConfigured) && (
            <div style={{ marginTop: 12 }}>
              <InlineNotice tone="warn" title="Stripe is not fully linked back to MeritBooks.">
                {!s.webhookConfigured ? 'Payment confirmations will not reach the books until the payment webhook is set up. ' : ''}
                {!s.connectWebhookConfigured ? 'Deposits and account changes will not show here until the Connect webhook is set up.' : ''}
              </InlineNotice>
            </div>
          )}
          <p className="t-cap" style={{ marginTop: 12 }}>
            Bank feed: Plaid {data.plaid.label}{data.plaid.configured ? '' : ' (not set up on the server)'}.{data.plaid.warning ? ` ${data.plaid.warning}` : ''}
          </p>
        </div>
      </section>

      {/* 02 // Companies */}
      <section aria-labelledby="pay-co-h">
        <div className="row row--between">
          <Eyebrow>{['02', 'Companies']}</Eyebrow>
          {counts.total > 0 && <span className="t-cap">{counts.online} of {counts.total} taking online payments · {counts.ready} Stripe account{counts.ready === 1 ? '' : 's'} ready</span>}
        </div>
        <h2 id="pay-co-h" className="sr">Companies</h2>
        {companies.length === 0 ? (
          <div className="surface wg-state mb-state-block" style={{ marginTop: 8 }}>
            <span className="t-head">No companies yet</span>
            <p>Add a company first — each company connects its own Stripe account and bank.</p>
            <ButtonLink href="/settings/new-entity">Add a company</ButtonLink>
          </div>
        ) : (
          <div className="surface mb-queue" style={{ marginTop: 8 }}>
            <QueueTable
              aria-label="Companies and their payment accounts"
              columns={columns}
              rows={companies}
              getRowId={(c) => c.locationId}
              rowState={(c) => ({ attn: c.account.readiness === 'restricted' })}
              cursorId={cursor}
              onCursorChange={(id) => setCursor(id)}
              onOpen={(c) => setOpenId(c.locationId)}
              openOnClick
              flush
            />
          </div>
        )}
        {companies.length > 0 && (
          <div className="mb-hints" style={{ marginTop: 8 }}>
            <Keyhints hints={[{ chord: 'j k', label: 'move' }, { chord: 'enter', label: 'open a company' }]} />
          </div>
        )}
      </section>

      {/* 03 // Account setup */}
      <section aria-labelledby="pay-setup-h">
        <Eyebrow>{['03', 'Account setup']}</Eyebrow>
        <h2 id="pay-setup-h" className="sr">Account setup</h2>
        <div className="surface" style={{ marginTop: 8, padding: 16 }}>
          <div role="radiogroup" aria-label="Stripe accounts">
            <Radio
              name="account-mode"
              label="Each company has its own Stripe account (recommended) — each company's customer payments go to its own bank."
              checked={data.accountMode === 'per_company'}
              disabled={!data.can.configure}
              onChange={() => setPendingMode('per_company')}
            />
            <Radio
              name="account-mode"
              label="One Stripe account for all companies — every company's customer payments go to the same bank account."
              checked={data.accountMode === 'single'}
              disabled={!data.can.configure}
              onChange={() => setPendingMode('single')}
            />
          </div>
          {data.accountMode === 'single' && !data.tenantAccount && data.can.configure && (
            <div style={{ marginTop: 12 }}>
              <InlineNotice tone="warn" title="No shared Stripe account yet.">
                Connect one and every company will collect into it.{' '}
                <Button variant="quiet" onClick={async () => {
                  const res = await api.post<{ url: string }>('/api/payments/connect', { location_id: null, intent: 'onboard' });
                  if (res.data?.url) window.location.href = res.data.url;
                  else addToast('error', res.error?.error || 'Stripe could not be opened.');
                }}>Connect the shared account</Button>
              </InlineNotice>
            </div>
          )}
          {data.accountMode === 'per_company' && data.tenantAccount && (
            <p className="t-cap" style={{ marginTop: 12 }}>
              A shared Stripe account also exists ({data.tenantAccount.readinessLabel.toLowerCase()}). It is not used while each company has its own account.
            </p>
          )}
        </div>
      </section>

      {/* 04 // What MeritBooks charges (Layer 1, read-only) */}
      {data.fees && (
        <section aria-labelledby="pay-fee-h">
          <Eyebrow>{['04', 'Processing fees']}</Eyebrow>
          <h2 id="pay-fee-h" className="sr">Processing fees</h2>
          <div className="surface" style={{ marginTop: 8, padding: 16 }}>
            <ul className="mb-activity">
              {data.fees.map((f) => (
                <li key={f.method}>
                  <span className="n">{f.method === 'CARD' ? 'Card' : 'Bank transfer (ACH)'}</span>
                  <span className="tnum">{f.rate} · {usd(f.exampleOn100000)} on $1,000.00</span>
                </li>
              ))}
            </ul>
            <p className="t-cap" style={{ marginTop: 8 }}>The processing fee for each online payment. Who pays it — the customer at checkout or the company — is set per company above.</p>
          </div>
        </section>
      )}

      {open && <CompanyDrawer company={open} overview={data} onClose={() => setOpenId(null)} onChanged={() => load(false)} />}

      <ConfirmDialog
        open={pendingMode !== null && pendingMode !== data.accountMode}
        onClose={() => setPendingMode(null)}
        onConfirm={() => (pendingMode ? applyMode(pendingMode) : undefined)}
        title={pendingMode === 'single' ? 'Use one Stripe account for all companies?' : 'Give each company its own Stripe account?'}
        confirmLabel={pendingMode === 'single' ? 'Use one account' : 'Use one account per company'}
        tone={pendingMode === 'single' ? 'danger' : 'primary'}
      >
        {pendingMode === 'single' ? (
          <p>Every company&rsquo;s customer payments will be deposited into the same bank account, and moving the money to the right company becomes a manual step. Companies that already have their own account keep using it.</p>
        ) : (
          <p>Companies without their own Stripe account will stop taking online payments until they connect one.</p>
        )}
      </ConfirmDialog>
    </div>
  );
}
