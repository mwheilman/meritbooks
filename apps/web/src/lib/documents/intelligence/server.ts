/**
 * Production wiring for the document-intelligence service: the service-role client,
 * the Anthropic key (handed only to the Core AI gateway), and a byte loader that refuses
 * any object outside the org's own folders of the private `documents` bucket.
 * Server-only.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { getAnthropicApiKey } from '@/lib/ai/gateway';
import { isOrgStoragePath } from '@/lib/documents/schema';
import { isOrgIntakePath } from '@/lib/uploads/paths';
import type { DocRow, IntelDeps } from './service';

export const DOCUMENTS_BUCKET = 'documents';
/** Never pull more than this into memory for hashing / reading. */
export const READ_MAX_BYTES = 25 * 1024 * 1024;

/** Uploads live at `{org}/…` (Documents center) or `intake/{org}/…` (drop-and-parse / onboarding). */
export function isReadablePath(orgId: string, path: string): boolean {
  return isOrgStoragePath(orgId, path) || isOrgIntakePath(path, orgId);
}

export function storageLoader(admin: SupabaseClient): (doc: DocRow) => Promise<Uint8Array | null> {
  return async (doc) => {
    if (!isReadablePath(doc.org_id, doc.storage_path)) return null;
    if (typeof doc.size_bytes === 'number' && doc.size_bytes > READ_MAX_BYTES) return null;
    const { data, error } = await admin.storage.from(DOCUMENTS_BUCKET).download(doc.storage_path);
    if (error || !data) return null;
    if (data.size > READ_MAX_BYTES) return null;
    return new Uint8Array(await data.arrayBuffer());
  };
}

/** Deps for a route / job. `admin` may be injected (the scheduler's service client). */
export function intelDeps(opts: { admin?: SupabaseClient; now?: () => Date } = {}): IntelDeps {
  const admin = opts.admin ?? createAdminSupabase();
  return {
    db: admin,
    anthropicApiKey: getAnthropicApiKey(),
    now: opts.now ?? (() => new Date()),
    loadBytes: storageLoader(admin),
  };
}
