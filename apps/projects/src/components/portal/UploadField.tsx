'use client';

import { useRef, useState } from 'react';
import { Button } from '@meritbooks/merit-ui';
import { portalUpload } from '@/lib/portal/client';
import { t } from '@/lib/portal/i18n';
import type { Locale } from '@/lib/portal/types';

export interface Uploaded { documentId: string; fileName: string }

const TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic'];

/** One or more files → /api/portal/uploads (camera on phones for photos). */
export function UploadField({ orgId, purpose, locale, label, accept = 'image/*,application/pdf', multiple = false, onUploaded }: {
  orgId: string; purpose: 'photo' | 'compliance' | 'pay_app' | 'message' | 'request'; locale: Locale; label?: string;
  accept?: string; multiple?: boolean; onUploaded: (f: Uploaded) => void;
}) {
  const input = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string[]>([]);
  const pick = async (files: FileList | null) => {
    if (!files) return;
    setError(null);
    for (const f of Array.from(files).slice(0, multiple ? 10 : 1)) {
      if (!TYPES.includes(f.type)) { setError(t(locale, 'upload.type')); continue; }
      if (f.size > 25 * 1024 * 1024) { setError(t(locale, 'upload.too_big')); continue; }
      setBusy(true);
      const r = await portalUpload(orgId, purpose, f);
      setBusy(false);
      if (!r.ok) { setError(r.error); continue; }
      setDone((d) => [...d, r.data.fileName]);
      onUploaded(r.data);
    }
    if (input.current) input.current.value = '';
  };
  return (
    <div>
      <input ref={input} type="file" accept={accept} multiple={multiple} hidden onChange={(e) => void pick(e.target.files)} />
      <Button onClick={() => input.current?.click()} disabled={busy}>{busy ? t(locale, 'upload.uploading') : label ?? t(locale, 'upload.choose')}</Button>
      {done.length > 0 && <p className="pt-cap" role="status">{t(locale, 'upload.done')}: {done.join(', ')}</p>}
      {error && <p className="pt-cap" role="alert" style={{ color: 'var(--neg)' }}>{error}</p>}
    </div>
  );
}
