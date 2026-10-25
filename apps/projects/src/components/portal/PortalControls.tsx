'use client';

import { useState } from 'react';
import { portalPost } from '@/lib/portal/client';
import { t } from '@/lib/portal/i18n';
import type { Locale } from '@/lib/portal/types';

export function LangToggle({ locale }: { locale: Locale }) {
  const [busy, setBusy] = useState(false);
  const next: Locale = locale === 'es' ? 'en' : 'es';
  return (
    <button type="button" className="lang" lang={next} disabled={busy} onClick={async () => {
      setBusy(true);
      await portalPost('/api/portal/locale', { locale: next });
      window.location.reload();
    }}>{t(locale, 'lang.switch')}</button>
  );
}

export function SignOutButton({ label }: { label: string }) {
  return (
    <button type="button" className="lang" onClick={async () => {
      await portalPost('/api/portal/auth', { op: 'sign_out' });
      window.location.href = '/portal/sign-in';
    }}>{label}</button>
  );
}
