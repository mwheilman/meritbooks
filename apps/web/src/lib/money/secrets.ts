/**
 * GATE 12 — server-only secret accessor.
 *
 * Provider credentials live in Supabase Vault, never in application tables. The
 * connection row (core.provider_connections) holds only a secret_ref (uuid).
 * These helpers call the SECURITY DEFINER RPCs created in migration 041, which
 * are executable by service_role only — so this module MUST be called with the
 * admin (service-role) Supabase client, from server code, never the browser.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

/** Store a secret in Vault; returns its reference (uuid) to persist on the connection row. */
export async function storeProviderSecret(
  adminDb: SupabaseClient,
  secret: string,
  name?: string,
): Promise<string> {
  const { data, error } = await adminDb.rpc('store_provider_secret', { p_secret: secret, p_name: name ?? null });
  if (error) throw new Error(`Vault store failed: ${error.message}`);
  const ref = data as string | null;
  if (!ref) throw new Error('Vault store returned no reference');
  return ref;
}

/** Read a secret by reference. Returns null if the ref is unknown. Server/service-role only. */
export async function readProviderSecret(adminDb: SupabaseClient, secretRef: string): Promise<string | null> {
  const { data, error } = await adminDb.rpc('read_provider_secret', { p_ref: secretRef });
  if (error) throw new Error(`Vault read failed: ${error.message}`);
  return (data as string | null) ?? null;
}

/** Overwrite a secret in place (rotation). */
export async function rotateProviderSecret(adminDb: SupabaseClient, secretRef: string, secret: string): Promise<void> {
  const { error } = await adminDb.rpc('rotate_provider_secret', { p_ref: secretRef, p_secret: secret });
  if (error) throw new Error(`Vault rotate failed: ${error.message}`);
}

/** Delete a secret. */
export async function deleteProviderSecret(adminDb: SupabaseClient, secretRef: string): Promise<void> {
  const { error } = await adminDb.rpc('delete_provider_secret', { p_ref: secretRef });
  if (error) throw new Error(`Vault delete failed: ${error.message}`);
}
