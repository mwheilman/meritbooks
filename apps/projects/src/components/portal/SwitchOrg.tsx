'use client';

import { useState } from 'react';
import { Button, Field, InlineNotice, Input } from '@meritbooks/merit-ui';
import { portalPost } from '@/lib/portal/client';
import { t } from '@/lib/portal/i18n';
import type { Locale } from '@/lib/portal/types';

/**
 * Open another company: each company signs you in on its own, so it sends a fresh code to the
 * address you already confirmed; type it here (this browser only).
 */
export function SwitchOrg({ orgId, name, locale }: { orgId: string; name: string; locale: Locale }) {
  const [sent, setSent] = useState(false);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="pt-card">
      <div className="ttl">{name}</div>
      {!sent ? (
        <div className="pt-actions">
          <Button variant="primary" disabled={busy} onClick={async () => {
            setBusy(true); setError(null);
            const r = await portalPost('/api/portal/auth', { op: 'switch', orgId });
            setBusy(false);
            if (!r.ok) return setError(r.code === 'rate_limited' ? t(locale, 'signin.rate') : r.error);
            setSent(true);
          }}>{t(locale, 'orgs.send_code')}</Button>
        </div>
      ) : (
        <form className="pt-form" style={{ marginTop: 8 }} onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true); setError(null);
          const r = await portalPost<{ orgId: string | null }>('/api/portal/auth', { op: 'verify_switch', code });
          setBusy(false);
          if (!r.ok) return setError(t(locale, r.reason === 'too_many' ? 'signin.too_many' : r.reason === 'expired' ? 'signin.expired' : 'signin.bad_code'));
          window.location.href = `/portal/o/${r.data.orgId ?? orgId}`;
        }}>
          <p className="pt-cap">{t(locale, 'orgs.code_sent', { company: name })}</p>
          <Field label={t(locale, 'signin.code')}>
            <Input value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" autoFocus />
          </Field>
          <div><Button type="submit" variant="primary" disabled={busy || code.length !== 6}>{t(locale, 'signin.verify')}</Button></div>
        </form>
      )}
      {error && <InlineNotice tone="neg" title={error} />}
    </div>
  );
}
