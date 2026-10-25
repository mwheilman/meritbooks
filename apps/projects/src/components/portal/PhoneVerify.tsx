'use client';

import { useState } from 'react';
import { Button, Field, InlineNotice, Input } from '@meritbooks/merit-ui';
import { portalPost } from '@/lib/portal/client';
import { t } from '@/lib/portal/i18n';
import type { Locale } from '@/lib/portal/types';

/** Phone step-up before approving / signing / paying (a code texted to the phone on file). */
export function PhoneVerify({ locale, hint, orgId, onVerified }: { locale: Locale; hint: string | null; orgId?: string; onVerified: () => void }) {
  const [sent, setSent] = useState(false);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="pt-sheet">
      <h2 style={{ marginTop: 0 }}>{t(locale, 'verify.title')}</h2>
      <p className="pt-lead">{t(locale, 'verify.lead', { hint: hint ?? '' })}</p>
      {!sent ? (
        <Button variant="primary" disabled={busy} onClick={async () => {
          setBusy(true); setError(null);
          const r = await portalPost<{ ok: boolean; reason: string | null }>('/api/portal/phone', { op: 'start', orgId: orgId ?? null });
          setBusy(false);
          if (!r.ok) return setError(r.error);
          if (!r.data.ok && r.data.reason !== 'already_verified') return setError(t(locale, 'verify.held'));
          if (r.data.reason === 'already_verified') return onVerified();
          setSent(true);
        }}>{t(locale, 'verify.send')}</Button>
      ) : (
        <form className="pt-form" onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true); setError(null);
          const r = await portalPost<{ ok: boolean; reason: string | null }>('/api/portal/phone', { op: 'verify', code });
          setBusy(false);
          if (!r.ok) return setError(r.error);
          if (!r.data.ok) return setError(t(locale, r.data.reason === 'too_many' ? 'signin.too_many' : r.data.reason === 'locked' ? 'signin.locked' : r.data.reason === 'expired' ? 'signin.expired' : 'signin.bad_code'));
          onVerified();
        }}>
          <Field label={t(locale, 'verify.code')}>
            <Input value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" autoFocus />
          </Field>
          <div><Button type="submit" variant="primary" disabled={busy || code.length !== 6}>{t(locale, 'verify.check')}</Button></div>
        </form>
      )}
      {error && <div style={{ marginTop: 8 }}><InlineNotice tone="neg" title={error} /></div>}
    </div>
  );
}
