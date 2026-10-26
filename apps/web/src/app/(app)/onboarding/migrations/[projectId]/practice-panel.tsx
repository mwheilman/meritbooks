'use client';

import { useState } from 'react';
import { Button, InlineNotice, Textarea } from '@meritbooks/merit-ui';
import { SHADOW_MODE_COPY } from '@/lib/onboarding/migration/stages';
import type { WorkspaceData } from '../_shared/dto';
import { useAction } from '../_shared/ui';
import s from '../migrations.module.css';

/**
 * Practice close (shadow close) is part 2. Here: say so plainly, keep the choice honest
 * (clean switch skips it automatically; a parallel plan needs a person to skip it with a
 * reason, which prints on the certificate).
 */
export function PracticeClosePanel({ data, onChanged }: { data: WorkspaceData; onChanged: () => void }) {
  const p = data.project;
  const skipped = (p.skipped_stages ?? []).includes('shadow_close');
  const [reason, setReason] = useState('');
  const { busy, run } = useAction();
  return (
    <section className={s.surface} aria-label="Practice close">
      <div className={s.padSm}>
        <p><b>Plan: {SHADOW_MODE_COPY[p.shadow_mode].label}.</b> {SHADOW_MODE_COPY[p.shadow_mode].detail}</p>
        <InlineNotice title="The side-by-side practice close arrives in the next release.">
          Until then, a clean switch checks the first MeritBooks close against trend and outside evidence, and a parallel plan is skipped with a reason.
        </InlineNotice>
      </div>
      {p.shadow_mode === 'parallel' && !skipped && (
        <div className={s.padSm}>
          <Textarea aria-label="Reason for skipping the practice close" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="For example: the lender accepted the certificate without a parallel month." />
          <div className={s.row} style={{ marginTop: 8 }}>
            <Button variant="primary" disabled={reason.trim().length < 10 || busy !== null} onClick={async () => { if (await run('skip', '/api/onboarding/migrations/project', { action: 'skip_practice_close', id: p.id, reason: reason.trim() })) onChanged(); }}>Skip the practice close</Button>
            <Button disabled={busy !== null} onClick={async () => { if (await run('cs', '/api/onboarding/migrations/project', { action: 'update_plan', id: p.id, shadow_mode: 'clean_switch' })) onChanged(); }}>Switch to a clean switch</Button>
          </div>
        </div>
      )}
      {(skipped || p.shadow_mode !== 'parallel') && <p className={s.padSm + ' ' + s.ink2}>Skipped — shown as skipped, never as done.</p>}
    </section>
  );
}
