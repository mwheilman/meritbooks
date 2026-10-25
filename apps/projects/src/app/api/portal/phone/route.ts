export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { portalHandler, portalJson } from '@/lib/portal/http';
import { portalRpc } from '@/lib/portal/db';
import { portalServerKey } from '@/lib/portal/config';
import { deliverSecret, phoneCodeText, type Dispatch } from '@/lib/portal/deliver';
import { sixDigitCode } from '@/lib/portal/tokens';

/**
 * PUBLIC (session cookie): phone step-up before approving, signing or paying. start texts a code to
 * the phone this session's company recorded (held until the company is live; the code goes straight
 * to the provider, never stored); verify checks it.
 */
const Body = z.discriminatedUnion('op', [
  z.object({ op: z.literal('start'), orgId: z.string().uuid().nullish() }),
  z.object({ op: z.literal('verify'), code: z.string().regex(/^\d{6}$/) }),
]);

export const POST = portalHandler({ body: Body }, async ({ body, session, meta }) => {
  if (body.op === 'start') {
    const key = portalServerKey();
    if (!key) return portalJson(503, { error: 'The portal is not set up yet. Contact the company.', code: 'not_set_up' });
    const code = sixDigitCode();
    const r = await portalRpc<{ ok: boolean; reason: string | null; phone_hint?: string; dispatch?: Dispatch | null }>('phone_start',
      { p_server_key: key, p_session: session, p_code: code, p_org: body.orgId ?? null });
    if (r.dispatch) {
      const sent = await deliverSecret(r.dispatch, phoneCodeText(r.dispatch, code));
      if (sent.status !== 'sent') return { ok: false, reason: 'held', phone_hint: r.phone_hint ?? null };
    }
    return { ok: r.ok, reason: r.reason, phone_hint: r.phone_hint ?? null };
  }
  const key = portalServerKey();
  if (!key) return portalJson(503, { error: 'The portal is not set up yet. Contact the company.', code: 'not_set_up' });
  return portalRpc<{ ok: boolean; reason: string | null }>('phone_verify', { p_server_key: key, p_session: session, p_code: body.code, p_ip: meta.ip });
});
