import 'server-only';
/**
 * Server-component data loading for portal pages: no session → sign-in; a session the database
 * refuses → sign-in; anything else the page shows as an error state.
 */
import { redirect } from 'next/navigation';
import { portalRpc, type PortalFn } from './db';
import { PortalError, type PortalErrorCode } from './errors';
import { sessionToken } from './session';

export type Loaded<T> = { ok: true; data: T } | { ok: false; code: PortalErrorCode; message: string };

export async function loadPortal<T>(fn: PortalFn, args: Record<string, unknown> = {}): Promise<Loaded<T>> {
  const session = sessionToken();
  if (!session) redirect('/portal/sign-in');
  try {
    return { ok: true, data: await portalRpc<T>(fn, { p_session: session, ...args }) };
  } catch (e) {
    if (e instanceof PortalError) {
      if (e.code === 'auth') redirect('/portal/sign-in?reason=session');
      return { ok: false, code: e.code, message: e.message };
    }
    throw e;
  }
}
