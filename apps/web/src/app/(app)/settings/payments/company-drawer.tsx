'use client';

import { useEffect, useMemo, useState } from 'react';
import { Button, ButtonRow, ConfirmDialog, Drawer, InlineNotice, KV, PanelSection, Radio, Switch, Tag } from '@meritbooks/merit-ui';
import { addToast } from '@/hooks';
import { api } from '@/lib/api-client';
import { ModeBadge, ReadinessStatus, TEST_RUN_LABEL, optionsEqual, payoutBankText, relativeTime, usd } from './payments-format';
import type { CompanyOptions, CompanyRow, FeeLine, FeePayer, PaymentsOverviewResponse, TestRun } from './payments-types';

interface Props {
  company: CompanyRow | null;
  overview: PaymentsOverviewResponse;
  onClose: () => void;
  onChanged: () => Promise<void>;
}

type Draft = Omit<CompanyOptions, 'usingDefaults'>;
type PendingClose = { run: TestRun; action: 'cancel' | 'refund' } | null;

function toDraft(o: CompanyOptions): Draft {
  return { cardEnabled: o.cardEnabled, achEnabled: o.achEnabled, checkEnabled: o.checkEnabled, cardFeePayer: o.cardFeePayer, achFeePayer: o.achFeePayer };
}

function feeExample(fees: FeeLine[] | null, method: 'CARD' | 'ACH'): string | null {
  const f = fees?.find((x) => x.method === method);
  return f ? `${f.rate} — ${usd(f.exampleOn100000)} on a $1,000.00 payment` : null;
}

/**
 * One company's payments: its Stripe account (connect / continue / open Stripe), how its
 * customers may pay and who pays each processing fee, and the $1 test payment.
 */
export function CompanyDrawer({ company, overview, onClose, onChanged }: Props) {
  const [draft, setDraft] = useState<Draft | null>(company ? toDraft(company.options) : null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [linking, setLinking] = useState<'onboard' | 'dashboard' | null>(null);
  const [confirmTest, setConfirmTest] = useState(false);
  const [pendingClose, setPendingClose] = useState<PendingClose>(null);
  const [lastPayPath, setLastPayPath] = useState<string | null>(null);

  useEffect(() => {
    setDraft(company ? toDraft(company.options) : null);
    setSaveError(null);
    setLastPayPath(null);
  }, [company]);

  const runs = useMemo(() => (company ? overview.testRuns.filter((r) => r.locationId === company.locationId) : []), [company, overview.testRuns]);

  if (!company || !draft) return null;
  const a = company.account;
  const canConfigure = overview.can.configure;
  const canEdit = overview.can.editOptions;
  const stripeUsable = overview.stripe.state === 'ready' || overview.stripe.state === 'misconfigured';
  const live = overview.stripe.mode === 'live';
  const dirty = !optionsEqual(company.options, draft);
  const sharedAccount = a.source === 'tenant';
  const openRun = runs.find((r) => r.state === 'awaiting_payment' || r.state === 'processing');

  async function openStripe(intent: 'onboard' | 'dashboard') {
    if (!company) return;
    setLinking(intent);
    const res = await api.post<{ url: string }>('/api/payments/connect', { location_id: sharedAccount ? null : company.locationId, intent });
    if (res.data?.url) {
      window.location.href = res.data.url;
      return;
    }
    addToast('error', res.error?.error || 'Stripe could not be opened. Try again.');
    setLinking(null);
  }

  async function save() {
    if (!company || !draft) return;
    setSaving(true);
    setSaveError(null);
    const res = await api.put<{ ok: boolean }>('/api/payments/company-options', {
      location_id: company.locationId,
      card_enabled: draft.cardEnabled,
      ach_enabled: draft.achEnabled,
      check_enabled: draft.checkEnabled,
      card_fee_payer: draft.cardFeePayer,
      ach_fee_payer: draft.achFeePayer,
    });
    setSaving(false);
    if (res.error) {
      const detail = res.error.details ? Object.values(res.error.details).flat()[0] : null;
      setSaveError(detail || res.error.error || 'Could not save. Try again.');
      return;
    }
    addToast('success', `Saved payment options · ${company.name}`);
    await onChanged();
  }

  async function runTest() {
    if (!company) return;
    const res = await api.post<{ run: TestRun; reused: boolean }>('/api/payments/test-payment', { location_id: company.locationId, confirm: true });
    if (res.error || !res.data) throw new Error(res.error?.error || 'Could not create the test payment.');
    setLastPayPath(res.data.run.payPath);
    addToast('success', res.data.reused ? 'Your open $1 test is ready to pay' : 'Created a $1 test invoice');
    await onChanged();
  }

  async function closeRun(p: NonNullable<PendingClose>) {
    const res = await api.post<{ run: TestRun }>('/api/payments/test-payment/close', { run_id: p.run.id, action: p.action, confirm: true });
    if (res.error) throw new Error(res.error.error || 'That did not work. Try again.');
    addToast('success', p.action === 'refund' ? 'Refunded the $1 test · books reversed' : 'Cancelled the $1 test');
    await onChanged();
  }

  const setPayer = (method: 'card' | 'ach', p: FeePayer) => setDraft((d) => (d ? { ...d, [method === 'card' ? 'cardFeePayer' : 'achFeePayer']: p } : d));

  const stripeButton = (() => {
    if (!canConfigure) return null;
    if (!a.hasAccount) {
      return (
        <Button variant="primary" disabled={!stripeUsable || linking !== null} onClick={() => void openStripe('onboard')}>
          {linking === 'onboard' ? 'Opening Stripe…' : 'Connect with Stripe'}
        </Button>
      );
    }
    if (a.readiness === 'ready') {
      return (
        <Button disabled={linking !== null} onClick={() => void openStripe('dashboard')} iconAfter="right">
          {linking === 'dashboard' ? 'Opening Stripe…' : 'Open Stripe dashboard'}
        </Button>
      );
    }
    return (
      <Button variant="primary" disabled={!stripeUsable || linking !== null} onClick={() => void openStripe('onboard')}>
        {linking === 'onboard' ? 'Opening Stripe…' : 'Continue Stripe setup'}
      </Button>
    );
  })();

  return (
    <>
      <Drawer
        open
        onClose={onClose}
        width={480}
        eyebrow={['Payments', company.shortCode ?? 'Company']}
        title={company.name}
        meta={company.acceptsOnline ? 'Customers can pay this company online' : 'Online payment is off for this company'}
        foot={
          canEdit ? (
            <>
              <span className="t-cap">{dirty ? 'Unsaved changes' : company.options.usingDefaults ? 'Using the standard defaults' : 'Saved'}</span>
              <span className="sp" />
              <Button onClick={() => setDraft(toDraft(company.options))} disabled={!dirty || saving}>
                Reset
              </Button>
              <Button variant="primary" onClick={() => void save()} disabled={!dirty || saving}>
                {saving ? 'Saving…' : 'Save'}
              </Button>
            </>
          ) : undefined
        }
      >
        <PanelSection title="01 // Stripe account" meta={<ModeBadge badge={a.modeBadge} />}>
          <KV
            items={[
              { term: 'Status', value: <ReadinessStatus readiness={a.readiness} label={a.readinessLabel} /> },
              { term: 'Deposits go to', value: payoutBankText(a) },
              { term: 'Account', value: a.source === 'tenant' ? 'Shared account for all companies' : a.hasAccount ? "This company's own account" : 'None yet' },
              { term: 'Last checked', value: relativeTime(a.checkedAt) },
            ]}
          />
          {a.problem && (
            <div style={{ marginTop: 12 }}>
              <InlineNotice tone={a.readiness === 'restricted' ? 'neg' : 'warn'} title={a.problem}>
                {a.requirementsDueCount > 0 ? `Stripe is asking for ${a.requirementsDueCount} more item${a.requirementsDueCount === 1 ? '' : 's'}.` : null}
              </InlineNotice>
            </div>
          )}
          {a.modeBadge === 'TEST' && (
            <p className="t-cap" style={{ marginTop: 8 }}>
              Test mode — no real money moves. Payments switch to live once the live Stripe keys are added to the server.
            </p>
          )}
          {stripeButton && <div style={{ marginTop: 12 }}><ButtonRow>{stripeButton}</ButtonRow></div>}
          {!canConfigure && <p className="t-cap" style={{ marginTop: 8 }}>Only an administrator can connect Stripe.</p>}
        </PanelSection>

        <PanelSection title="02 // How customers can pay">
          <fieldset disabled={!canEdit} style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="sr">Accepted payment methods</legend>
            <div className="stack">
              <div>
                <Switch label="Card" checked={draft.cardEnabled} onChange={(e) => setDraft({ ...draft, cardEnabled: e.target.checked })} />
                {draft.cardEnabled && (
                  <div role="radiogroup" aria-label="Who pays the card processing fee" style={{ marginLeft: 40, marginTop: 4 }}>
                    <Radio name="card-payer" label="The customer pays it (added at checkout)" checked={draft.cardFeePayer === 'customer'} onChange={() => setPayer('card', 'customer')} />
                    <Radio name="card-payer" label="The company absorbs it" checked={draft.cardFeePayer === 'company'} onChange={() => setPayer('card', 'company')} />
                    {feeExample(overview.fees, 'CARD') && <p className="t-cap">Card fee: {feeExample(overview.fees, 'CARD')}</p>}
                  </div>
                )}
              </div>
              <div>
                <Switch label="Bank transfer (ACH)" checked={draft.achEnabled} onChange={(e) => setDraft({ ...draft, achEnabled: e.target.checked })} />
                {draft.achEnabled && (
                  <div role="radiogroup" aria-label="Who pays the bank transfer fee" style={{ marginLeft: 40, marginTop: 4 }}>
                    <Radio name="ach-payer" label="The company absorbs it" checked={draft.achFeePayer === 'company'} onChange={() => setPayer('ach', 'company')} />
                    <Radio name="ach-payer" label="The customer pays it (added at checkout)" checked={draft.achFeePayer === 'customer'} onChange={() => setPayer('ach', 'customer')} />
                    {feeExample(overview.fees, 'ACH') && <p className="t-cap">Bank transfer fee: {feeExample(overview.fees, 'ACH')}</p>}
                  </div>
                )}
              </div>
              <Switch label="Mailed check (shows the remit-to address)" checked={draft.checkEnabled} onChange={(e) => setDraft({ ...draft, checkEnabled: e.target.checked })} />
            </div>
          </fieldset>
          <p className="t-cap" style={{ marginTop: 8 }}>These are the company defaults. A customer, job or single invoice can still override them.</p>
          {saveError && (
            <div style={{ marginTop: 8 }}>
              <InlineNotice tone="neg" title="Not saved.">{saveError}</InlineNotice>
            </div>
          )}
          {!canEdit && <p className="t-cap" style={{ marginTop: 8 }}>You can view these options but not change them.</p>}
        </PanelSection>

        <PanelSection title="03 // $1 test payment" meta={live ? <Tag tone="neg">Real money</Tag> : <Tag tone="warn">Test money</Tag>}>
          <p className="t-cap">
            Pay a $1.00 invoice into this company&rsquo;s Stripe account to prove the whole path: payment, deposit to {payoutBankText(a) === '—' ? 'its bank' : payoutBankText(a)}, and the entry in the books. Refund it afterwards and the books go back to exactly where they were.
          </p>
          {canConfigure && (
            <div style={{ marginTop: 12 }}>
              <ButtonRow>
                <Button disabled={!company.acceptsOnline} onClick={() => setConfirmTest(true)}>
                  {openRun ? 'Show the open $1 test' : 'Run a $1 test payment'}
                </Button>
              </ButtonRow>
            </div>
          )}
          {!company.acceptsOnline && <p className="t-cap" style={{ marginTop: 8 }}>Available once Stripe is ready and card or bank transfer is on.</p>}
          {lastPayPath && (
            <div style={{ marginTop: 12 }}>
              <InlineNotice tone="info" title="Your $1 invoice is ready.">
                <a className="mb-nlink" href={lastPayPath} target="_blank" rel="noreferrer">Open the pay page</a> and pay it{live ? ' with your own card or bank account' : ' with a Stripe test card (4242 4242 4242 4242) or test bank account'}.
              </InlineNotice>
            </div>
          )}
          {runs.length > 0 && (
            <ul className="mb-activity" style={{ marginTop: 12 }} aria-label="Recent test payments">
              {runs.slice(0, 5).map((r) => (
                <li key={r.id}>
                  <span>
                    <span className="n">{r.invoiceNumber ?? 'Test invoice'}</span>{' '}
                    <Tag tone={TEST_RUN_LABEL[r.state].tone}>{TEST_RUN_LABEL[r.state].label}</Tag>
                    <span className="l2">{usd(r.amountCents)} · {r.environment === 'live' ? 'live' : 'test'} · {relativeTime(r.createdAt)}</span>
                  </span>
                  <span className="row">
                    {r.payPath && r.state === 'awaiting_payment' && (
                      <a className="btn btn--quiet" href={r.payPath} target="_blank" rel="noreferrer">Pay</a>
                    )}
                    {canConfigure && r.state === 'awaiting_payment' && (
                      <Button variant="quiet" onClick={() => setPendingClose({ run: r, action: 'cancel' })}>Cancel</Button>
                    )}
                    {canConfigure && r.state === 'paid' && (
                      <Button variant="danger" onClick={() => setPendingClose({ run: r, action: 'refund' })}>Refund</Button>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </PanelSection>
      </Drawer>

      <ConfirmDialog
        open={confirmTest}
        onClose={() => setConfirmTest(false)}
        onConfirm={runTest}
        title={live ? `Charge a real $1.00 to ${company.name}?` : `Create a $1.00 test invoice for ${company.name}?`}
        confirmLabel={openRun ? 'Show the open test' : live ? 'Create the $1 invoice' : 'Create the test invoice'}
        tone="primary"
        footNote="The invoice is booked to this company. Cancel it before paying, or refund it after — either way the books net to zero."
      >
        {live ? (
          <p>This is live: paying it moves $1.00 of real money into this company&rsquo;s Stripe account. Pay it yourself, then refund it here.</p>
        ) : (
          <p>Test mode: no real money moves. Pay it with a Stripe test card or test bank account.</p>
        )}
      </ConfirmDialog>

      <ConfirmDialog
        open={pendingClose !== null}
        onClose={() => setPendingClose(null)}
        onConfirm={() => (pendingClose ? closeRun(pendingClose) : undefined)}
        title={pendingClose?.action === 'refund' ? 'Refund the $1 test payment?' : 'Cancel the $1 test invoice?'}
        confirmLabel={pendingClose?.action === 'refund' ? 'Refund $1.00' : 'Cancel the test'}
        tone="danger"
      >
        {pendingClose?.action === 'refund' ? (
          <p>Stripe returns the $1.00 to the payer, and both journal entries for this test are reversed. This cannot be undone.</p>
        ) : (
          <p>The test invoice is voided and its journal entry reversed. Its pay link stops working.</p>
        )}
      </ConfirmDialog>
    </>
  );
}
