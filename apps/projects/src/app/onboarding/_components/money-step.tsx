'use client';

import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import { Button, ButtonLink, Field, InlineNotice, MoneyInput, PageHead, Pip, Textarea } from '@meritbooks/merit-ui';
import type { CompanyBrief } from '@/lib/onboarding/types';
import { getJson, postJson } from '@/components/imports/api';

type Phase =
  | { kind: 'idle' }
  | { kind: 'sending' }
  | { kind: 'waiting'; depositId: string; tries: number }
  | { kind: 'posted'; depositId: string }
  | { kind: 'unissued'; depositId: string }
  | { kind: 'rejected'; reason: string | null }
  | { kind: 'error'; message: string };

interface DepositsResponse { deposits: { id: string; status: string; rejection_reason?: string | null }[] }

const POLL_MS = 3000;
const MAX_TRIES = 20;

/**
 * Step 7 — the money moment: request a deposit on the first job. Projects sends JOB_DEPOSIT_REQUEST;
 * Merit Books numbers the invoice and posts it; this screen waits for Books' answer ("Posted ✓").
 */
export function MoneyStep({ company, firstJobId, booksUrl, onContinue, onBack, primaryRef }: {
  company: CompanyBrief;
  firstJobId: string | null;
  booksUrl: string;
  onContinue: () => void;
  onBack: () => void;
  primaryRef: MutableRefObject<(() => void) | null>;
}) {
  const [amount, setAmount] = useState<number | null>(null);
  const [memo, setMemo] = useState('Deposit to schedule the work');
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => { primaryRef.current = onContinue; });
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const poll = (depositId: string, tries: number) => {
    timer.current = setTimeout(async () => {
      const r = await getJson<DepositsResponse>(`/api/jobs/${firstJobId}/deposits`);
      const d = r.ok ? r.data.deposits.find((x) => x.id === depositId) : null;
      if (d?.status === 'ISSUED') { setPhase({ kind: 'posted', depositId }); return; }
      if (d?.status === 'REJECTED') { setPhase({ kind: 'rejected', reason: d.rejection_reason ?? null }); return; }
      if (d?.status === 'UNISSUED') { setPhase({ kind: 'unissued', depositId }); return; }
      if (tries + 1 >= MAX_TRIES) { setPhase({ kind: 'waiting', depositId, tries: MAX_TRIES }); return; }
      setPhase({ kind: 'waiting', depositId, tries: tries + 1 });
      poll(depositId, tries + 1);
    }, POLL_MS);
  };

  const request = async () => {
    if (!firstJobId || !amount || amount <= 0) return;
    setPhase({ kind: 'sending' });
    const r = await postJson<{ depositId: string; status: string }>(`/api/jobs/${firstJobId}/deposits`, { amountCents: amount, memo: memo.trim() || null });
    if (!r.ok) { setPhase({ kind: 'error', message: r.error }); return; }
    if (r.data.status === 'UNISSUED') { setPhase({ kind: 'unissued', depositId: r.data.depositId }); return; }
    setPhase({ kind: 'waiting', depositId: r.data.depositId, tries: 0 });
    poll(r.data.depositId, 0);
  };

  return (
    <>
      <PageHead eyebrow={['Set up', company.name, 'Optional']} title="Get paid on it">
        <p className="ob-lede">Ask for a deposit on your first job. Merit Books numbers the invoice, posts it and sends the pay link; you see it land here.</p>
      </PageHead>

      {!firstJobId ? (
        <InlineNotice title="Pick or add a job first.">Go back one step, or skip this and request deposits from any job later.</InlineNotice>
      ) : (
        <section className="ob-card" aria-labelledby="mm-h">
          <div className="ob-card-h"><h3 id="mm-h">Deposit request</h3><span className="sp" /><ButtonLink variant="quiet" href={`/jobs/${firstJobId}`}>Open the job</ButtonLink></div>
          <div className="ob-card-b ob-stack">
            <div className="ob-grid2">
              <Field label="Amount"><MoneyInput valueCents={amount} onChangeCents={setAmount} disabled={phase.kind !== 'idle' && phase.kind !== 'error'} /></Field>
              <Field label="What it’s for (on the invoice)"><Textarea rows={2} value={memo} onChange={(e) => setMemo(e.currentTarget.value)} maxLength={200} /></Field>
            </div>
            {phase.kind === 'error' && <InlineNotice tone="neg" title={phase.message} />}
            {phase.kind === 'waiting' && (
              <p className="ob-busy" role="status"><Pip kind="track" />{phase.tries >= MAX_TRIES ? 'Still waiting on Merit Books. It will post shortly; you can go on.' : 'Sent. Waiting on Merit Books to number and post the invoice…'}</p>
            )}
            {phase.kind === 'posted' && <p role="status"><Pip kind="ready" /> <b>Posted ✓</b> Merit Books issued the deposit invoice. <a className="link" href={`${booksUrl}/invoices`} target="_blank" rel="noreferrer">See it in Books</a></p>}
            {phase.kind === 'unissued' && <InlineNotice title="Recorded, not invoiced.">Merit Books isn’t on for this company, so the request is kept as a document marked "not invoiced". It posts once Books is turned on.</InlineNotice>}
            {phase.kind === 'rejected' && <InlineNotice tone="warn" title="Merit Books sent it back.">{phase.reason ?? 'Open the job to see why and send it again.'}</InlineNotice>}
            <div><Button variant="primary" disabled={!amount || amount <= 0 || (phase.kind !== 'idle' && phase.kind !== 'error')} onClick={request}>{phase.kind === 'sending' ? 'Sending…' : 'Request the deposit'}</Button></div>
          </div>
        </section>
      )}

      <div className="ob-foot">
        <Button variant="quiet" chord="escape" onClick={onBack}>Back</Button>
        <span className="sp" />
        <Button variant="primary" size="lg" chord="enter" onClick={onContinue}>{phase.kind === 'posted' || phase.kind === 'waiting' || phase.kind === 'unissued' ? 'Continue' : 'Skip for now'}</Button>
      </div>
    </>
  );
}
