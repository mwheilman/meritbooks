import 'server-only';
/**
 * Portal file bytes on the ANON key (never the service role). Migration 1118's storage policies
 * let anon insert exactly an open upload slot (portal.upload_begin) and read exactly an object a
 * session was just granted for 2 minutes (portal.file_grant). The app passes the path the
 * database returned — the browser never chooses or sees it.
 */
import { createClient } from '@supabase/supabase-js';

export interface StoragePort {
  upload(path: string, bytes: ArrayBuffer, contentType: string): Promise<boolean>;
  download(path: string): Promise<ArrayBuffer | null>;
}

let port: StoragePort | null = null;

function anonStorage(): StoragePort {
  const bucket = () => createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  }).storage.from('documents');
  return {
    async upload(path, bytes, contentType) {
      const r = await bucket().upload(path, bytes, { contentType, upsert: false });
      return !r.error;
    },
    async download(path) {
      const r = await bucket().download(path);
      return r.error || !r.data ? null : r.data.arrayBuffer();
    },
  };
}

export function setStoragePort(p: StoragePort | null): void {
  port = p;
}

export function portalStorage(): StoragePort {
  return port ?? (port = anonStorage());
}

/** The only keys the portal ever moves: `<org uuid>/…` without traversal. Pure. */
export function isPortalObjectPath(path: string, org: string): boolean {
  return path.startsWith(`${org}/`) && !path.includes('..') && /^[0-9a-f-]{36}\/[A-Za-z0-9_./() -]+$/i.test(path);
}

export const UPLOAD_TYPES: Readonly<Record<string, string>> = {
  'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic',
};
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
