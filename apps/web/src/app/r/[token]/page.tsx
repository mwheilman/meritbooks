export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { sharedRateLimiter } from '@/lib/security/rate-limit';
import { openRequestLink } from '@/lib/requests/public-link';
import { PublicRequestFrame, PublicRequestNotice } from './frame';

export const metadata = { title: { absolute: 'Request' }, robots: { index: false, follow: false } };

const PER_TOKEN = { windowMs: 60_000, max: 20 };
const PER_IP = { windowMs: 60_000, max: 60 };

/**
 * /r/[token] — the magic link in a request email (FPB-request-engine-notifications §4).
 * PUBLIC (middleware), no login: the token is resolved by its sha256 with the service
 * role; a W-9 / COI request forwards to the existing vendor upload portal, anything else
 * shows what was asked. Bad, expired or closed links reveal nothing about the tenant.
 */
export default async function RequestLinkPage({ params }: { params: { token: string } }) {
  const h = headers();
  const ip = (h.get('x-forwarded-for') ?? '').split(',')[0].trim() || h.get('x-real-ip') || 'unknown';
  const throttle = sharedRateLimiter.checkAll([
    { key: `request-link:token:${params.token.slice(0, 64)}`, rule: PER_TOKEN },
    { key: `request-link:ip:${ip}`, rule: PER_IP },
  ]);
  if (!throttle.allowed) {
    return <PublicRequestNotice heading="Too many tries" body="Please wait a minute and open the link again." />;
  }

  const res = await openRequestLink(createAdminSupabase(), params.token);
  if (res.state === 'redirect') redirect(res.to);
  if (res.state === 'invalid') {
    return (
      <PublicRequestNotice
        heading={res.reason === 'closed' ? 'Nothing more is needed' : 'This link has expired'}
        body={
          res.reason === 'closed'
            ? 'This request has been taken care of. Thank you — you can close this page.'
            : 'Please reply to the email you received, or ask the sender for a new link.'
        }
      />
    );
  }

  const v = res.view;
  return (
    <PublicRequestFrame eyebrow={`${v.kindLabel} request`} sender={v.senderName} brand={v.brand}>
      <h1 className="t-title" style={{ margin: '8px 0 0' }}>
        {v.title}
      </h1>
      {v.message && (
        <p className="ink-2" style={{ whiteSpace: 'pre-line', marginTop: 12 }}>
          {v.message}
        </p>
      )}
      {v.dueDate && (
        <p className="t-cap" style={{ marginTop: 12 }}>
          Needed by <span className="tnum">{v.dueDate}</span>
        </p>
      )}
      <div className="inline-notice" role="note" style={{ marginTop: 20 }}>
        <span>
          To answer, reply to the email from {v.senderName} with what they asked for. Answering right here is coming soon.
        </span>
      </div>
      {!v.unsubscribed && (
        <p className="t-cap" style={{ marginTop: 24 }}>
          <a href={`/r/${encodeURIComponent(params.token)}/unsubscribe`}>Stop these emails</a>
        </p>
      )}
    </PublicRequestFrame>
  );
}
