import { createClient } from '@/lib/supabase/client';

const DOCUMENTS_BUCKET = 'documents';

/**
 * uploadForParse — send a document straight to Supabase storage and return its path,
 * so a drop-and-parse route can read it server-side WITHOUT the file ever passing
 * through a Vercel function body (which caps at ~4.5MB). Flow:
 *   1. ask the server for a one-time signed upload URL (org-scoped path),
 *   2. PUT the file directly to storage via that signed URL.
 * The caller then POSTs `{ storagePath }` (a tiny JSON body) to the parse endpoint.
 */
export async function uploadForParse(file: File): Promise<{ storagePath: string } | { error: string }> {
  let path: string;
  let token: string;
  try {
    const signRes = await fetch('/api/uploads/sign', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fileName: file.name }),
    });
    if (!signRes.ok) {
      const b = (await signRes.json().catch(() => ({}))) as { error?: string };
      return { error: b.error ?? 'Could not prepare the upload. Please try again.' };
    }
    const signed = (await signRes.json()) as { path: string; token: string };
    path = signed.path;
    token = signed.token;
  } catch {
    return { error: 'Could not reach the server to start the upload.' };
  }

  try {
    const supabase = createClient();
    const { error } = await supabase.storage.from(DOCUMENTS_BUCKET).uploadToSignedUrl(path, token, file);
    if (error) return { error: 'The upload failed. Please try again.' };
    return { storagePath: path };
  } catch {
    return { error: 'The upload failed. Please try again.' };
  }
}
