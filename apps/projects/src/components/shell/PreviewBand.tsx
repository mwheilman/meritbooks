'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, toast } from '@meritbooks/merit-ui';

/**
 * The persistent "Previewing as <title> — Exit" band (spec §4). The kit's Sky view-as band,
 * without the countdown: a preview has no time limit, it only narrows what the owner sees.
 */
export function PreviewBand({ title }: { title: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const exit = async () => {
    setBusy(true);
    const res = await api.delete<{ ok: true }>('/api/access/preview');
    setBusy(false);
    if (res.error) {
      toast.error(res.error.error);
      return;
    }
    toast('Exited the preview');
    router.refresh();
  };
  return (
    <div className="viewas-band" role="status" aria-live="polite">
      <span>
        <b>Previewing as {title}</b>
        <span className="sl" aria-hidden="true">
          {'//'}
        </span>
        <span className="sr">, </span>
        You see what a {title.toLowerCase()} sees. Nothing you couldn’t already see is shown.
      </span>
      <span className="sp" />
      <button className="btn" type="button" onClick={() => void exit()} disabled={busy} aria-busy={busy || undefined}>
        {busy ? 'Exiting…' : 'Exit preview'}
      </button>
    </div>
  );
}
