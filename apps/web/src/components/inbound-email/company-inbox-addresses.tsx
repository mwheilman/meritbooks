'use client';

import { useMemo } from 'react';
import { Button, ButtonLink, Eyebrow, Tag } from '@meritbooks/merit-ui';
import { useQuery } from '@/hooks';
import { CopyAddress } from './copy-address';
import type { InboxAlias, InboxOverview } from './types';

/**
 * Settings → Companies: every company's bills and receipts address, each with Copy.
 * Not scoped to the active company (this is the tenant's company list).
 */
export function CompanyInboxAddresses() {
  const { data, isLoading, error, refetch } = useQuery<InboxOverview>('/api/inbound-email', undefined, { scope: false });

  const byCompany = useMemo(() => {
    const m = new Map<string, { name: string; ap?: InboxAlias; receipts?: InboxAlias }>();
    for (const a of data?.aliases ?? []) {
      const row = m.get(a.locationId) ?? { name: a.companyName };
      row[a.purpose] = a;
      m.set(a.locationId, row);
    }
    return Array.from(m.entries());
  }, [data]);

  return (
    <section className="surface" aria-labelledby="co-inbox-h" style={{ padding: 16 }}>
      <div className="row row--between" style={{ flexWrap: 'wrap', gap: 8 }}>
        <div>
          <Eyebrow>{['Email', 'Company inboxes']}</Eyebrow>
          <h2 id="co-inbox-h" className="t-head" style={{ marginTop: 4 }}>Where to send bills and receipts</h2>
        </div>
        <div className="row" style={{ gap: 8, alignItems: 'center' }}>
          {data && (data.status.state === 'active' ? <Tag tone="pos">Active</Tag> : <Tag tone="warn">Not yet active</Tag>)}
          <ButtonLink href="/settings/inbound-email" variant="quiet">Email inboxes</ButtonLink>
        </div>
      </div>
      {data && data.status.state !== 'active' && (
        <p className="t-cap" style={{ marginTop: 6 }}>Not yet active — your admin needs to finish email setup. You can already share the addresses.</p>
      )}
      {isLoading && !data ? (
        <div className="wg-loading" aria-busy="true" style={{ marginTop: 8 }}>
          <span className="bar-l" style={{ width: '60%' }} aria-hidden="true" />
          <span className="t-cap" role="status">Loading addresses…</span>
        </div>
      ) : error ? (
        <div role="alert" style={{ marginTop: 8 }}>
          <p className="t-cap">The addresses didn’t load: {error}</p>
          <Button variant="quiet" onClick={() => void refetch()}>Try again</Button>
        </div>
      ) : byCompany.length === 0 ? (
        <p className="t-cap" style={{ marginTop: 8 }}>Add a company and it gets its addresses automatically.</p>
      ) : (
        <ul className="mb-activity" style={{ marginTop: 8 }}>
          {byCompany.map(([id, c]) => (
            <li key={id} style={{ display: 'grid', gridTemplateColumns: 'minmax(140px, 220px) 1fr', gap: 8, alignItems: 'start' }}>
              <span className="n">{c.name}</span>
              <span className="stack" style={{ gap: 4 }}>
                {c.ap && <span className="row" style={{ gap: 8, flexWrap: 'wrap' }}><span className="t-cap" style={{ width: 64 }}>Bills</span><CopyAddress address={c.ap.address} size="sm" /></span>}
                {c.receipts && <span className="row" style={{ gap: 8, flexWrap: 'wrap' }}><span className="t-cap" style={{ width: 64 }}>Receipts</span><CopyAddress address={c.receipts.address} size="sm" /></span>}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
