'use client';

import { useState } from 'react';
import { Button, Field, InlineNotice, Input } from '@meritbooks/merit-ui';
import { portalPost } from '@/lib/portal/client';
import { t, type PortalKey } from '@/lib/portal/i18n';
import type { Locale } from '@/lib/portal/types';

const REASON_KEY: Readonly<Record<string, PortalKey>> = {
  other_device: 'auth.other_device', used: 'auth.used', expired: 'auth.expired', invalid: 'auth.invalid', replaced: 'auth.used',
  session: 'err.auth', not_set_up: 'signin.not_set_up', unavailable: 'err.generic',
};
const CODE_KEY: Readonly<Record<string, PortalKey>> = {
  wrong_code: 'signin.bad_code', expired: 'signin.expired', locked: 'signin.locked', too_many: 'signin.too_many', rate_limited: 'signin.rate', invalid: 'signin.bad_code',
};

/** Email or mobile → link + 6-digit code (no password). The code works only in this browser. */
export function SignInForm({ locale, reason, orgId = null }: { locale: Locale; reason?: string | null; orgId?: string | null }) {
  const [step, setStep] = useState<'ask' | 'code'>('ask');
  const [who, setWho] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = async () => {
    setBusy(true); setError(null);
    const r = await portalPost('/api/portal/auth', { op: 'start', identifier: who.trim(), locale, orgId });
    setBusy(false);
    if (!r.ok) return setError(r.code === 'rate_limited' ? t(locale, 'signin.rate') : r.code === 'not_set_up' ? t(locale, 'signin.not_set_up') : r.error);
    setStep('code');
  };
  const verify = async () => {
    setBusy(true); setError(null);
    const r = await portalPost('/api/portal/auth', { op: 'verify', identifier: who.trim(), code: code.trim() });
    setBusy(false);
    if (!r.ok) return setError(t(locale, CODE_KEY[r.reason ?? r.code] ?? 'signin.bad_code'));
    window.location.href = '/portal';
  };

  return (
    <div className="pt-center">
      <h1 style={{ fontFamily: 'var(--f-display)', fontSize: 'var(--t-28)', lineHeight: 'var(--lh-28)' }}>{t(locale, step === 'ask' ? 'signin.title' : 'signin.sent_title')}</h1>
      {reason && REASON_KEY[reason] && step === 'ask' && (
        <InlineNotice tone="warn" title={t(locale, 'auth.title')}>{t(locale, REASON_KEY[reason])}</InlineNotice>
      )}
      {step === 'ask' ? (
        <form className="pt-form" style={{ marginTop: 16 }} onSubmit={(e) => { e.preventDefault(); void send(); }}>
          <p className="pt-lead">{t(locale, 'signin.lead')}</p>
          <Field label={t(locale, 'signin.identifier')}>
            <Input value={who} onChange={(e) => setWho(e.target.value)} autoComplete="username" inputMode="email" required maxLength={254} autoFocus />
          </Field>
          {error && <InlineNotice tone="neg" title={error} />}
          <Button type="submit" variant="primary" size="lg" disabled={busy || who.trim().length < 5}>{busy ? t(locale, 'signin.sending') : t(locale, 'signin.send')}</Button>
        </form>
      ) : (
        <form className="pt-form" style={{ marginTop: 16 }} onSubmit={(e) => { e.preventDefault(); void verify(); }}>
          <p className="pt-lead">{t(locale, 'signin.sent', { who: who.trim() })}</p>
          <Field label={t(locale, 'signin.code')}>
            <Input value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" required autoFocus />
          </Field>
          {error && <InlineNotice tone="neg" title={error} />}
          <Button type="submit" variant="primary" size="lg" disabled={busy || code.length !== 6}>{t(locale, 'signin.verify')}</Button>
          <Button variant="quiet" onClick={() => { setStep('ask'); setCode(''); setError(null); }}>{t(locale, 'signin.other')}</Button>
        </form>
      )}
    </div>
  );
}
