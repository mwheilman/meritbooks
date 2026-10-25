import 'server-only';
/**
 * The portal's database access: the ANON key, no Clerk session, schema `portal` only. Every
 * portal.* function is a session-token scoped SECURITY DEFINER function (migration 1118) that sees
 * nothing but what that person's grants reach. Never the service role.
 */
import { createClient } from '@supabase/supabase-js';
import { mapPortalError, PortalError } from './errors';

export type PortalFn =
  | 'auth_start' | 'auth_switch' | 'auth_verify_switch' | 'dispatch_result' | 'auth_redeem' | 'auth_verify_code' | 'sign_out' | 'phone_start' | 'phone_verify' | 'set_locale' | 'me'
  | 'home' | 'job' | 'draw' | 'item' | 'invoices' | 'vendor' | 'messages'
  | 'decide' | 'esign_link' | 'post_message' | 'service_request' | 'task_respond' | 'accept_commitment' | 'punch_ready'
  | 'compliance_submit' | 'submit_pay_app' | 'upload_begin' | 'upload_finish' | 'file_grant';

export interface RpcResult { data: unknown; error: { message: string; code?: string } | null }
export type RpcPort = (fn: PortalFn, args: Record<string, unknown>) => Promise<RpcResult>;

let port: RpcPort | null = null;

function anonPort(): RpcPort {
  const client = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  }).schema('portal');
  return async (fn, args) => {
    const r = await client.rpc(fn, args);
    return { data: r.data, error: r.error ? { message: r.error.message, code: r.error.code } : null };
  };
}

/** Tests swap the database port. */
export function setPortalPort(p: RpcPort | null): void {
  port = p;
}

/** Call one portal function; database refusals become PortalError (status + plain sentence). */
export async function portalRpc<T>(fn: PortalFn, args: Record<string, unknown>): Promise<T> {
  const p = port ?? (port = anonPort());
  let r: RpcResult;
  try {
    r = await p(fn, args);
  } catch {
    throw new PortalError(503, 'unavailable', 'The portal is not responding. Try again in a minute.');
  }
  if (r.error) {
    const m = mapPortalError(r.error);
    if (m.code === 'unavailable') console.error('[portal]', fn, r.error.code, r.error.message);
    throw new PortalError(m.status, m.code, m.message);
  }
  return r.data as T;
}
