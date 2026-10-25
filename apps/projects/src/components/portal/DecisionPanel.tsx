'use client';

import { useState } from 'react';
import { Button, Check, Field, InlineNotice, Input, Textarea } from '@meritbooks/merit-ui';
import { portalPost } from '@/lib/portal/client';
import { money } from '@/lib/portal/format';
import { t } from '@/lib/portal/i18n';
import type { Locale, PortalHome, SelectionOption } from '@/lib/portal/types';
import { PhoneVerify } from './PhoneVerify';

export interface DecisionProps {
  orgId: string;
  kind: 'estimate' | 'change_order' | 'selection' | 'draw' | 'commitment';
  id: string;
  locale: Locale;
  company: string;
  canAct: boolean;
  verified: PortalHome['verified'];
  phoneHint: string | null;
  signerId?: string | null;
  decided?: string | null;
  options?: readonly SelectionOption[];
  allowanceCents?: number | null;
  /** Draws: per-line approved amounts the lender typed. */
  lines?: { line_id: string; approved_cents: number }[] | null;
}

/**
 * Approve / decline (typed name + consent = an electronic signature on the decision), choose a
 * selection option, accept a contract — or open the e-sign page when the company sent the document
 * for signature. Phone step-up first when the person has a phone on file.
 */
export function DecisionPanel(p: DecisionProps) {
  const { locale } = p;
  const [verified, setVerified] = useState(p.verified !== null);
  const [option, setOption] = useState<string | null>(p.options?.find((o) => o.recommended)?.id ?? null);
  const [name, setName] = useState('');
  const [consent, setConsent] = useState(false);
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(!!p.decided);

  if (done) return <InlineNotice title={t(locale, 'item.decided', { company: p.company })} />;
  if (!p.canAct) return <InlineNotice tone="warn" title={t(locale, 'item.viewer')} />;
  if (!verified) return <PhoneVerify locale={locale} hint={p.phoneHint} orgId={p.orgId} onVerified={() => setVerified(true)} />;

  if (p.signerId) {
    return (
      <div className="pt-actions">
        <Button variant="primary" size="lg" disabled={busy} onClick={async () => {
          setBusy(true); setError(null);
          const r = await portalPost<{ url: string }>('/api/portal/actions', { op: 'sign', orgId: p.orgId, signerId: p.signerId });
          if (!r.ok) { setBusy(false); return setError(r.error); }
          window.location.href = r.data.url;
        }}>{busy ? t(locale, 'item.signing') : t(locale, 'item.sign_now')}</Button>
        {error && <InlineNotice tone="neg" title={error} />}
      </div>
    );
  }

  const submit = async (decision: 'approved' | 'declined') => {
    setBusy(true); setError(null);
    const r = p.kind === 'commitment'
      ? await portalPost('/api/portal/actions', { op: 'accept', orgId: p.orgId, commitmentId: p.id, typedName: name.trim(), consent: true })
      : await portalPost('/api/portal/actions', {
          op: 'decide', orgId: p.orgId, kind: p.kind, id: p.id, decision, typedName: name.trim(), consent: true,
          optionId: p.kind === 'selection' && decision === 'approved' ? option : null,
          comment: decision === 'declined' ? reason.trim() : null, lines: p.kind === 'draw' ? p.lines ?? null : null,
        });
    setBusy(false);
    if (!r.ok) return setError(r.error);
    setDone(true);
  };

  return (
    <div className="pt-sheet">
      {p.kind === 'selection' && p.options && (
        <div role="radiogroup" aria-label={t(locale, 'kind.selection')} style={{ marginBottom: 12 }}>
          {p.options.map((o) => (
            <label key={o.id} className="pt-opt" data-on={option === o.id}>
              <input type="radio" name="opt" checked={option === o.id} onChange={() => setOption(o.id)} />
              <span>
                <b>{o.label}</b>{o.recommended ? <span className="pt-cap"> · {t(locale, 'item.recommended')}</span> : null}
                {o.description ? <span className="pt-cap" style={{ display: 'block' }}>{o.description}</span> : null}
                {o.lead_time_days ? <span className="pt-cap" style={{ display: 'block' }}>{t(locale, 'item.lead_time', { n: o.lead_time_days })}</span> : null}
              </span>
              <span className="n">
                {money(o.amount_cents, locale)}
                {o.delta_cents !== null && (
                  <span className="pt-cap" style={{ display: 'block' }}>
                    {o.delta_cents > 0 ? t(locale, 'impact.over', { amount: money(o.delta_cents, locale) })
                      : o.delta_cents < 0 ? t(locale, 'impact.under', { amount: money(-o.delta_cents, locale) }) : t(locale, 'impact.at')}
                  </span>
                )}
              </span>
            </label>
          ))}
        </div>
      )}
      <form className="pt-form" onSubmit={(e) => { e.preventDefault(); void submit(declining ? 'declined' : 'approved'); }}>
        {declining && (
          <Field label={t(locale, 'item.reason')}><Textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={2000} rows={3} required /></Field>
        )}
        <Field label={t(locale, 'item.typed_name')}><Input value={name} onChange={(e) => setName(e.target.value)} maxLength={200} autoComplete="name" /></Field>
        <Check label={t(locale, 'item.consent')} checked={consent} onChange={(e) => setConsent(e.target.checked)} />
        {error && <InlineNotice tone="neg" title={error} />}
        <div className="pt-actions">
          {declining ? (
            <>
              <Button type="submit" variant="danger" disabled={busy || !consent || name.trim().length < 2 || reason.trim().length < 2}>{busy ? t(locale, 'item.sending') : t(locale, 'item.decline')}</Button>
              <Button variant="quiet" onClick={() => setDeclining(false)}>{t(locale, 'item.approve')}</Button>
            </>
          ) : (
            <>
              <Button type="submit" variant="primary" size="lg" disabled={busy || !consent || name.trim().length < 2 || (p.kind === 'selection' && !option)}>
                {busy ? t(locale, 'item.sending') : t(locale, p.kind === 'selection' ? 'item.choose' : p.kind === 'commitment' ? 'item.accept' : p.kind === 'draw' ? 'draw.approve_all' : 'item.approve')}
              </Button>
              {p.kind !== 'commitment' && <Button variant="quiet" onClick={() => setDeclining(true)}>{t(locale, p.kind === 'draw' ? 'draw.return' : 'item.decline')}</Button>}
            </>
          )}
        </div>
      </form>
    </div>
  );
}
