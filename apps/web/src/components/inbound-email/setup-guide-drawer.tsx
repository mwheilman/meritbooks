'use client';

import { useEffect, useState } from 'react';
import { Drawer, Eyebrow, InlineNotice, KV, PanelSection, Tag } from '@meritbooks/merit-ui';
import type { InboxStatus } from './types';
import { CopyAddress } from './copy-address';

/**
 * The IT one-pager, in the app (mirrors docs/IT-AP-EMAIL-SETUP.md). Plain English,
 * provider-specific values filled in, never a secret. Also: how staff forward an
 * existing AP mailbox from Gmail / Outlook, and how to send a test.
 */
export function SetupGuideDrawer({
  open,
  onClose,
  status,
  exampleAddress,
}: {
  open: boolean;
  onClose: () => void;
  status: InboxStatus | null;
  exampleAddress: string | null;
}) {
  const [host, setHost] = useState('your-app-address');
  useEffect(() => {
    if (typeof window !== 'undefined') setHost(window.location.host);
  }, []);

  const provider = status?.provider ?? 'postmark';
  const domain = status?.domain ?? 'inbound.meritbooks.app';
  const sub = domain.split('.')[0];
  const parent = domain.split('.').slice(1).join('.');
  const mx = status?.mxHost ?? 'inbound.postmarkapp.com';
  const webhook = `https://meritbooks:YOUR-PASSWORD@${host}/api/webhooks/inbound-email`;

  return (
    <Drawer
      open={open}
      onClose={onClose}
      width={560}
      eyebrow={['Help', 'Email inboxes']}
      title="Turn on the bills inbox"
      meta="About 20 minutes for whoever manages your domain and Vercel. Nothing here changes your normal email."
    >
      {status && (
        <div style={{ marginBottom: 16 }}>
          {status.state === 'active' ? (
            <InlineNotice title="Email setup is finished on the server.">
              Mail sent to your company addresses is being read. If nothing arrives, check step 2 (the MX record) and step 3 (the webhook).
            </InlineNotice>
          ) : (
            <InlineNotice tone="warn" title="Not yet active — your admin needs to finish email setup.">
              {status.missing.length > 0 ? status.missing.join(' ') : 'Follow the steps below, then come back here.'}
            </InlineNotice>
          )}
        </div>
      )}

      <PanelSection title="What this does">
        <p className="t-body">
          Every company gets its own address, like <b>{exampleAddress ?? `ap-yourcompany@${domain}`}</b>. Vendors email bills there (or
          you forward them). Each PDF becomes a draft bill on that company, with the vendor filled in. Nothing is paid or posted until
          someone approves it.
        </p>
      </PanelSection>

      <PanelSection title={provider === 'sendgrid' ? '1. SendGrid account' : '1. Create a Postmark account'}>
        {provider === 'sendgrid' ? (
          <ol className="t-body" style={{ paddingLeft: 18 }}>
            <li>In SendGrid, open Settings → Inbound Parse → Add Host &amp; URL.</li>
            <li>Host: <b>{domain}</b>. URL: the webhook address in step 3. Leave “Send Raw” <b>off</b>.</li>
            <li>Optional but recommended: turn on a Security Policy with signature verification and copy its public key (step 4).</li>
          </ol>
        ) : (
          <ol className="t-body" style={{ paddingLeft: 18 }}>
            <li>Go to postmarkapp.com and sign up (the free trial is enough to test).</li>
            <li>Create a <b>Server</b> called “MeritBooks inbound”.</li>
            <li>Open that server’s <b>Inbound</b> message stream → Settings.</li>
            <li>In <b>Inbound domain</b>, enter <b>{domain}</b> and save.</li>
          </ol>
        )}
      </PanelSection>

      <PanelSection title="2. Add one DNS record">
        <p className="t-body">In the DNS settings for <b>{parent || domain}</b> (GoDaddy, Cloudflare, Route 53, …) add:</p>
        <KV items={[
          { term: 'Type', value: 'MX' },
          { term: 'Name / host', value: sub },
          { term: 'Value / points to', value: mx },
          { term: 'Priority', value: '10' },
        ]} />
        <p className="t-cap" style={{ marginTop: 8 }}>This only affects addresses ending in @{domain}. Your normal company email is not touched.</p>
      </PanelSection>

      <PanelSection title="3. Point the inbox at MeritBooks">
        <p className="t-body">
          Make up a long password (20+ characters — a password manager can generate one). In {provider === 'sendgrid' ? 'SendGrid' : 'Postmark’s Inbound settings'}, set the
          <b> webhook URL</b> to this, with your password in place of YOUR-PASSWORD:
        </p>
        <div style={{ marginTop: 8 }}><CopyAddress address={webhook} label="Copy URL" size="sm" /></div>
      </PanelSection>

      <PanelSection title="4. Add the settings in Vercel">
        <p className="t-body">Vercel → the MeritBooks project → Settings → Environment Variables → add, for Production:</p>
        <KV items={[
          { term: 'INBOUND_EMAIL_PROVIDER', value: provider },
          { term: 'INBOUND_EMAIL_DOMAIN', value: domain },
          { term: 'INBOUND_EMAIL_SECRET', value: 'the password from step 3' },
          ...(provider === 'sendgrid' ? [{ term: 'SENDGRID_INBOUND_PUBLIC_KEY', value: 'the security policy public key (optional)' }] : []),
        ]} />
        <p className="t-cap" style={{ marginTop: 8 }}>Then redeploy (Deployments → ⋯ → Redeploy). This page will switch to <Tag tone="pos">Active</Tag>.</p>
      </PanelSection>

      <PanelSection title="5. Send a test">
        <ol className="t-body" style={{ paddingLeft: 18 }}>
          <li>From your own email, send any invoice PDF to {exampleAddress ? <b>{exampleAddress}</b> : 'a company’s AP address'}.</li>
          <li>Within a minute it appears in <b>Bills → Intake</b> as a draft on that company, showing who sent it.</li>
          <li>Settings → Email inboxes shows the message and what happened to it.</li>
        </ol>
      </PanelSection>

      <PanelSection title="Forward an existing AP mailbox">
        <Eyebrow>Gmail / Google Workspace</Eyebrow>
        <ol className="t-body" style={{ paddingLeft: 18, marginBottom: 12 }}>
          <li>Gmail → Settings (gear) → See all settings → <b>Forwarding and POP/IMAP</b> → Add a forwarding address.</li>
          <li>Enter the company’s AP address. Gmail sends a confirmation email to it.</li>
          <li>That confirmation shows up in <b>Settings → Email inboxes</b> here — click <b>Confirm in Gmail</b> (or type the code).</li>
          <li>Back in Gmail choose “Forward a copy of incoming mail to …”. Tip: use a filter (has attachment, from your vendors) instead of forwarding everything.</li>
        </ol>
        <Eyebrow>Outlook / Microsoft 365</Eyebrow>
        <ol className="t-body" style={{ paddingLeft: 18 }}>
          <li>Outlook on the web → Settings → Mail → <b>Rules</b> → Add new rule → “Forward to” the company’s AP address (or Mail → Forwarding to forward everything).</li>
          <li>Microsoft 365 blocks forwarding outside your company by default. Your IT admin may need to allow it: Microsoft Defender → Policies → Anti-spam → Outbound policy → Automatic forwarding “On” for that mailbox.</li>
        </ol>
      </PanelSection>
    </Drawer>
  );
}
