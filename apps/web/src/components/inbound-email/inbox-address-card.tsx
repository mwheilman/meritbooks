'use client';

import { useMemo, useState } from 'react';
import { Button, ButtonLink, Eyebrow, Tag } from '@meritbooks/merit-ui';
import { useQuery } from '@/hooks';
import { CopyAddress } from './copy-address';
import { SetupGuideDrawer } from './setup-guide-drawer';
import { type InboxOverview, type InboxPurpose, whenText } from './types';

/**
 * "Forward bills to …" — the company's inbox address with a Copy button, whether it
 * is live, and what arrived this week. Scoped to the active company (useQuery adds
 * location_id). Used on Bills, the AP intake queue and onboarding.
 */
export function InboxAddressCard({
  purpose = 'ap',
  index = '01',
  locationId,
  variant = 'full',
}: {
  purpose?: InboxPurpose;
  index?: string;
  /** Force a company (onboarding); otherwise the active company. */
  locationId?: string | null;
  variant?: 'full' | 'compact';
}) {
  const params = useMemo(() => (locationId ? { location_id: locationId } : undefined), [locationId]);
  const { data, isLoading, error, refetch } = useQuery<InboxOverview>('/api/inbound-email', params);
  const [guideOpen, setGuideOpen] = useState(false);

  const aliases = (data?.aliases ?? []).filter((a) => a.purpose === purpose);
  const alias = aliases[0] ?? null;
  const active = data?.status.state === 'active';
  const label = purpose === 'ap' ? 'AP inbox' : 'Receipts inbox';
  const lede = purpose === 'ap' ? 'Forward vendor bills to' : 'Forward receipts to';

  if (isLoading && !data) {
    return (
      <section className="surface wg-loading" aria-busy="true" style={{ padding: 16 }}>
        <span className="bar-l" style={{ width: '36%' }} aria-hidden="true" />
        <span className="bar-l" style={{ width: '58%' }} aria-hidden="true" />
        <span className="t-cap" role="status">Loading the inbox address…</span>
      </section>
    );
  }
  if (error || !data) {
    return (
      <section className="surface wg-state" role="alert" style={{ padding: 16 }}>
        <span className="t-head">The inbox address didn’t load</span>
        <p className="t-cap">{error ?? 'Unknown error.'}</p>
        <Button onClick={() => void refetch()}>Try again</Button>
      </section>
    );
  }
  if (!alias) {
    return (
      <section className="surface" style={{ padding: 16 }}>
        <Eyebrow>{[index, label]}</Eyebrow>
        <p className="t-body" style={{ marginTop: 8 }}>No inbox address for this company yet. Pick a single company, or add one in setup.</p>
      </section>
    );
  }

  const stats = data.stats;
  return (
    <section className="surface" aria-labelledby={`inbox-${purpose}-h`} style={{ padding: 16 }}>
      <div className="row row--between" style={{ alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
        <div style={{ minWidth: 0, flex: '1 1 320px' }}>
          <Eyebrow>{[index, label]}</Eyebrow>
          <h2 id={`inbox-${purpose}-h`} className="sr">{label} for {alias.companyName}</h2>
          <p className="t-cap" style={{ marginTop: 6 }}>{lede} {aliases.length > 1 ? 'each company’s own address' : alias.companyName}:</p>
          <div style={{ marginTop: 4 }}>
            <CopyAddress address={alias.address} />
          </div>
          {variant === 'full' && (
            <p className="t-cap" style={{ marginTop: 8 }}>
              {active
                ? `${stats.last7d} email${stats.last7d === 1 ? '' : 's'} this week · ${stats.drafted7d} turned into ${purpose === 'ap' ? 'draft bills' : 'receipts'}${stats.problems7d ? ` · ${stats.problems7d} need a look` : ''} · last received ${whenText(stats.lastReceivedAt)}`
                : 'Share it with vendors now — mail starts flowing the moment setup is finished.'}
            </p>
          )}
          {aliases.length > 1 && <p className="t-cap" style={{ marginTop: 4 }}>{aliases.length} companies have their own address — see them all in Email inboxes.</p>}
        </div>
        <div className="stack" style={{ alignItems: 'flex-end', gap: 8 }}>
          {!alias.isActive || !alias.companyActive ? (
            <Tag tone="warn">Switched off</Tag>
          ) : active ? (
            <Tag tone="pos">Active</Tag>
          ) : (
            <Tag tone="warn">Not yet active</Tag>
          )}
          <div className="row" style={{ gap: 8 }}>
            <Button variant="quiet" onClick={() => setGuideOpen(true)}>{active ? 'How it works' : 'Set up'}</Button>
            {variant === 'full' && <ButtonLink href={`/settings/inbound-email?company=${alias.locationId}`} variant="quiet">Inbox log</ButtonLink>}
          </div>
        </div>
      </div>
      {!active && variant === 'full' && (
        <p className="t-cap ink-2" style={{ marginTop: 8 }}>Not yet active — your admin needs to finish email setup.</p>
      )}
      {alias.forwardingConfirmation && data.can.manage && (
        <p className="t-cap" style={{ marginTop: 8 }}>
          <Tag tone="ai">Action</Tag> Gmail is waiting for you to confirm forwarding{alias.forwardingConfirmation.requestedBy ? ` from ${alias.forwardingConfirmation.requestedBy}` : ''}. Open Email inboxes to confirm.
        </p>
      )}
      <SetupGuideDrawer open={guideOpen} onClose={() => setGuideOpen(false)} status={data.status} exampleAddress={alias.address} />
    </section>
  );
}
