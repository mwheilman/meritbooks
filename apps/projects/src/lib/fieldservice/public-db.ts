import 'server-only';
/**
 * Database access for the PUBLIC field-service routes (no Clerk session): provider webhooks, the
 * cron tick and the customer's client hub. The ANON key only — never the service role. What anon
 * may execute is exactly public.fs_voice_event / fs_inbound_sms / fs_cron_tick (each fails closed
 * without FS_WIDGET_SERVER_KEY, whose sha-256 Merit ops registers in pm.fs_widget_server_keys) and
 * portal.fs_hub / fs_estimate / fs_estimate_accept / fs_confirm_visit (portal session scoped).
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { mapPortalError, PortalError } from '@/lib/portal/errors';

let pub: SupabaseClient | null = null;

function anonClient(): SupabaseClient {
  pub ??= createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return pub;
}

export interface PublicRpcResult<T> { data: T | null; error: { message: string; code?: string } | null }
export type PublicPort = (schema: 'public' | 'portal', fn: string, args: Record<string, unknown>) => Promise<PublicRpcResult<unknown>>;

let port: PublicPort | null = null;

/** Tests swap the port. */
export function setFsPublicPort(p: PublicPort | null): void {
  port = p;
}

const defaultPort: PublicPort = async (schema, fn, args) => {
  const c = schema === 'portal' ? anonClient().schema('portal') : anonClient();
  const r = await c.rpc(fn, args);
  return { data: r.data as unknown, error: r.error ? { message: r.error.message, code: r.error.code } : null };
};

export const serverKey = (): string | null => process.env.FS_WIDGET_SERVER_KEY || null;

/** public.fs_* (server key) — errors returned, not thrown (webhooks answer the provider themselves). */
export async function fsPublicRpc<T>(fn: 'fs_voice_event' | 'fs_inbound_sms' | 'fs_cron_tick', args: Record<string, unknown>): Promise<PublicRpcResult<T>> {
  const p = port ?? defaultPort;
  const r = await p('public', fn, { p_server_key: serverKey(), ...args });
  return r as PublicRpcResult<T>;
}

/** portal.fs_* (session) — refusals become PortalError (status + plain sentence) like lib/portal/db. */
export async function fsPortalRpc<T>(fn: 'fs_hub' | 'fs_estimate' | 'fs_estimate_accept' | 'fs_confirm_visit', args: Record<string, unknown>): Promise<T> {
  const p = port ?? defaultPort;
  let r: PublicRpcResult<unknown>;
  try {
    r = await p('portal', fn, args);
  } catch {
    throw new PortalError(503, 'unavailable', 'The portal is not responding. Try again in a minute.');
  }
  if (r.error) {
    const m = mapPortalError(r.error);
    throw new PortalError(m.status, m.code, m.message);
  }
  return r.data as T;
}
