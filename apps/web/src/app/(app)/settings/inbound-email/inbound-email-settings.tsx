'use client';

import { useMemo, useState } from 'react';
import { Button, Eyebrow, InlineNotice, KV, QueueTable, Tag, type QueueColumn } from '@meritbooks/merit-ui';
import { PageHeader } from '@/components/ui';
import { addToast, useQuery } from '@/hooks';
import { api } from '@/lib/api-client';
import { CopyAddress } from '@/components/inbound-email/copy-address';
import { SetupGuideDrawer } from '@/components/inbound-email/setup-guide-drawer';
import { PURPOSE_LABEL, RULE_LABEL, whenText, type InboxAlias, type InboxOverview } from '@/components/inbound-email/types';
import { AliasRulesDrawer } from './alias-rules-drawer';
import { InboundLog } from './inbound-log';

const MX_TEXT: Record<'ok' | 'missing' | 'wrong' | 'unknown', string> = {
  ok: 'MX record found and pointing at the provider.',
  missing: 'No MX record found for the domain yet (DNS changes can take up to an hour).',
  wrong: 'The MX record points somewhere else.',
  unknown: 'Could not check DNS right now.',
};

/**
 * Settings → Email inboxes (FPB-ap-intake §5, merit-ui). Status of the inbound email
 * setup, every company's ap- and receipts- address with Copy, who may send to each,
 * Gmail forwarding confirmations waiting for a click, and the inbound log.
 */
export function InboundEmailSettings({ initialCompany }: { initialCompany: string | null }) {
  const [checkMx, setCheckMx] = useState(false);
  const params = useMemo(() => (checkMx ? { check_mx: '1' } : undefined), [checkMx]);
  // All companies the caller can see (scope: false — this is a tenant settings screen).
  const { data, isLoading, error, refetch } = useQuery<InboxOverview>('/api/inbound-email', params, { scope: false });
  const [editing, setEditing] = useState<InboxAlias | null>(null);
  const [guideOpen, setGuideOpen] = useState(false);
  const [cursor, setCursor] = useState<string | null>(null);

  const aliases = useMemo(() => data?.aliases ?? [], [data]);
  const confirmations = aliases.filter((a) => a.forwardingConfirmation);
  const canManage = data?.can.manage ?? false;

  async function dismiss(a: InboxAlias) {
    const res = await api.patch<{ alias: InboxAlias }>('/api/inbound-email/aliases', { alias_id: a.id, dismiss_forwarding: true });
    if (res.data) {
      addToast('success', 'Cleared.');
      void refetch();
    } else addToast('error', res.error?.error ?? 'Could not clear it.');
  }

  const columns: QueueColumn<InboxAlias>[] = [
    { id: 'company', header: 'Company', width: 220, cell: (a) => <><span className="l1">{a.companyName}</span><span className="l2">{PURPOSE_LABEL[a.purpose]}</span></> },
    { id: 'address', header: 'Address', cell: (a) => <CopyAddress address={a.address} size="sm" /> },
    { id: 'rule', header: 'Who can send', width: 180, cell: (a) => RULE_LABEL[a.senderRule] },
    {
      id: 'status',
      header: 'Status',
      width: 130,
      cell: (a) =>
        !a.isActive ? <Tag tone="warn">Switched off</Tag>
          : !a.companyActive ? <Tag tone="warn">Company inactive</Tag>
            : data?.status.state === 'active' ? <Tag tone="pos">Active</Tag> : <Tag tone="warn">Not yet active</Tag>,
    },
    { id: 'last', header: 'Last email', width: 140, cell: (a) => <><span className="l1">{whenText(a.lastReceivedAt)}</span><span className="l2">{a.messagesCount} total</span></> },
    {
      id: 'act',
      header: <span className="sr">Edit</span>,
      width: 96,
      cell: (a) => (canManage ? <Button variant="quiet" onClick={(e) => { e.stopPropagation(); setEditing(a); }}>Settings</Button> : null),
    },
  ];

  const header = (
    <PageHeader
      eyebrow={['Settings', 'Email inboxes']}
      title="Email inboxes"
      description="Each company has its own address for vendor bills and one for receipts. Mail sent there becomes draft bills (or receipts) on that company — nothing is paid or posted until someone approves it."
      actions={<Button onClick={() => setGuideOpen(true)}>Setup guide</Button>}
    />
  );

  if (isLoading && !data) {
    return (
      <div>
        {header}
        <div className="surface wg-loading mb-state-block" aria-busy="true">
          <span className="bar-l" style={{ width: '60%' }} aria-hidden="true" />
          <span className="bar-l" style={{ width: '44%' }} aria-hidden="true" />
          <span className="t-cap" role="status">Loading email inboxes…</span>
        </div>
      </div>
    );
  }
  if (error || !data) {
    return (
      <div>
        {header}
        <div className="surface wg-state mb-state-block" role="alert">
          <span className="tag tag--neg">Not loaded</span>
          <span className="t-head">Email inboxes didn’t load</span>
          <p>{error}</p>
          <Button onClick={() => void refetch()}>Try again</Button>
        </div>
      </div>
    );
  }

  const s = data.status;
  return (
    <div className="stack">
      {header}

      {/* 01 // Status */}
      <section aria-labelledby="ibx-status-h">
        <Eyebrow>{['01', 'Status']}</Eyebrow>
        <h2 id="ibx-status-h" className="sr">Status</h2>
        <div className="surface" style={{ marginTop: 8, padding: 16 }}>
          {s.state === 'active' ? (
            <div className="row" style={{ gap: 8 }}><Tag tone="pos">Active</Tag><span className="ink">Inbound email is set up — mail to your company addresses is being read.</span></div>
          ) : (
            <InlineNotice tone="warn" title="Not yet active — your admin needs to finish email setup.">
              {s.missing.length ? s.missing.join(' ') : 'An administrator can see exactly what is missing here.'}{' '}
              <Button variant="quiet" onClick={() => setGuideOpen(true)}>Open the setup guide</Button>
            </InlineNotice>
          )}
          <div style={{ marginTop: 12 }}>
            <KV items={[
              { term: 'Email service', value: s.providerLabel },
              { term: 'Inbound domain', value: `${s.domain}${s.domainConfigured ? '' : ' (planned)'}` },
              { term: 'Webhook password', value: s.credentialConfigured ? 'Set' : 'Not set' },
              ...(s.mxHost ? [{ term: 'MX record should point to', value: s.mxHost }] : []),
            ]} />
          </div>
          {canManage && (
            <div className="row" style={{ gap: 8, marginTop: 12, alignItems: 'center' }}>
              <Button variant="quiet" onClick={() => (checkMx ? void refetch() : setCheckMx(true))}>Check DNS</Button>
              {data.mx && (
                <span className="t-cap">
                  <Tag tone={data.mx.state === 'ok' ? 'pos' : data.mx.state === 'unknown' ? 'default' : 'warn'}>MX</Tag> {MX_TEXT[data.mx.state]}
                  {data.mx.hosts.length ? ` Found: ${data.mx.hosts.join(', ')}.` : ''}
                </span>
              )}
            </div>
          )}
        </div>
      </section>

      {/* 02 // Addresses */}
      <section aria-labelledby="ibx-addr-h">
        <div className="row row--between">
          <Eyebrow>{['02', 'Addresses']}</Eyebrow>
          <span className="t-cap">{aliases.length} address{aliases.length === 1 ? '' : 'es'} · give the Bills address to vendors, the Receipts address to your team</span>
        </div>
        <h2 id="ibx-addr-h" className="sr">Addresses</h2>
        {aliases.length === 0 ? (
          <div className="surface wg-state mb-state-block" style={{ marginTop: 8 }}>
            <span className="t-head">No companies yet</span>
            <p>Each company gets its addresses automatically when it is added.</p>
          </div>
        ) : (
          <div className="surface mb-queue" style={{ marginTop: 8 }}>
            <QueueTable
              aria-label="Company email inbox addresses"
              columns={columns}
              rows={aliases}
              getRowId={(a) => a.id}
              rowState={(a) => ({ attn: Boolean(a.forwardingConfirmation) })}
              cursorId={cursor}
              onCursorChange={(id) => setCursor(id)}
              onOpen={(a) => (canManage ? setEditing(a) : undefined)}
              flush
            />
          </div>
        )}
      </section>

      {/* 03 // Forwarding confirmations */}
      {confirmations.length > 0 && (
        <section aria-labelledby="ibx-fwd-h">
          <Eyebrow>{['03', 'Forwarding to confirm']}</Eyebrow>
          <h2 id="ibx-fwd-h" className="sr">Forwarding confirmations</h2>
          <div className="stack" style={{ marginTop: 8, gap: 8 }}>
            {confirmations.map((a) => {
              const f = a.forwardingConfirmation!;
              return (
                <div key={a.id} className="surface" style={{ padding: 16 }}>
                  <p className="t-body">
                    <b>{f.requestedBy ?? 'A Gmail account'}</b> wants to forward its mail to <b>{a.address}</b> ({a.companyName}).
                    {f.code ? <> Confirmation code: <b>{f.code}</b>.</> : !canManage ? <> An admin can confirm it here.</> : null}
                  </p>
                  {!f.authenticated && (
                    <p className="t-cap" style={{ marginTop: 4 }}>We could not verify this came from Google. Only confirm if you (or your team) just set up this forwarding.</p>
                  )}
                  <div className="row" style={{ gap: 8, marginTop: 8 }}>
                    {f.url && canManage && (
                      <a className="btn btn--primary" href={f.url} target="_blank" rel="noopener noreferrer">Confirm in Gmail</a>
                    )}
                    {canManage && <Button variant="quiet" onClick={() => void dismiss(a)}>Done — clear this</Button>}
                    <span className="t-cap">Received {whenText(f.receivedAt)}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      <InboundLog aliases={aliases} initialCompany={initialCompany} canManage={canManage} onAliasChanged={() => void refetch()} />

      <AliasRulesDrawer alias={editing} onClose={() => setEditing(null)} onSaved={() => void refetch()} />
      <SetupGuideDrawer open={guideOpen} onClose={() => setGuideOpen(false)} status={s} exampleAddress={aliases.find((a) => a.purpose === 'ap')?.address ?? null} />
    </div>
  );
}
