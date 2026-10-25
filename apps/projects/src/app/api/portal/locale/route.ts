export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { cookies } from 'next/headers';
import { portalHandler } from '@/lib/portal/http';
import { portalRpc } from '@/lib/portal/db';
import { sessionToken } from '@/lib/portal/session';
import { LOCALE_COOKIE } from '@/lib/portal/tokens';

/** PUBLIC: EN / ES. Remembered in a cookie, and on the person when signed in. */
const Body = z.object({ locale: z.enum(['en', 'es']) });

export const POST = portalHandler({ body: Body, auth: false }, async ({ body }) => {
  cookies().set(LOCALE_COOKIE, body.locale, { path: '/', sameSite: 'lax', maxAge: 60 * 60 * 24 * 365 });
  const s = sessionToken();
  if (s) await portalRpc('set_locale', { p_session: s, p_locale: body.locale }).catch(() => null);
  return { ok: true, locale: body.locale };
});
