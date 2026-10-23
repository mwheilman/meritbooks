export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { createAdminSupabase } from '@/lib/supabase/admin';
import { resolveRequestToken } from '@/lib/requests/tokens';
import { PublicRequestFrame, PublicRequestNotice } from '../frame';

export const metadata = { title: { absolute: 'Stop these emails' }, robots: { index: false, follow: false } };

/**
 * /r/[token]/unsubscribe — confirm, then POST (a link scanner's GET never unsubscribes
 * anyone). The POST lands on /api/r/unsubscribe, which adds a per-tenant suppression for
 * the address and records it on the request timeline.
 */
export default async function UnsubscribePage({ params, searchParams }: { params: { token: string }; searchParams: { done?: string } }) {
  if (searchParams.done === '1') {
    return <PublicRequestNotice heading="You won’t get these emails anymore" body="We’ve let the sender know. If this was a mistake, reply to any earlier email and ask them to add you back." />;
  }
  const res = await resolveRequestToken(createAdminSupabase(), params.token);
  if (!res.ok) {
    return <PublicRequestNotice heading="This link has expired" body="There is nothing to unsubscribe from on this link." />;
  }
  return (
    <PublicRequestFrame eyebrow="Email preferences" sender={null}>
      <h1 className="t-head" style={{ margin: 0 }}>
        Stop request emails to {res.request.recipient_email ?? 'this address'}?
      </h1>
      <p className="ink-2" style={{ marginTop: 8 }}>
        You will no longer get reminders like “{res.request.title}” from this sender by email.
      </p>
      <form method="post" action="/api/r/unsubscribe" style={{ marginTop: 20 }}>
        <input type="hidden" name="token" value={params.token} />
        <button type="submit" className="btn btn--primary">
          Stop these emails
        </button>
      </form>
    </PublicRequestFrame>
  );
}
