/**
 * Server-only storage for the two things on a check nobody should be able to read back:
 * the FULL MICR routing / account numbers (Supabase Vault, via the 041 RPCs) and the
 * signature images (private `check-signatures` bucket, mig 182 — no member object policy).
 *
 * The database keeps only last-4 masks plus pointers, and the pointers themselves are
 * column-revoked from members (mig 182 field masks). These helpers take the SERVICE-ROLE
 * client and are called only after the route's permission check + org pin.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { readProviderSecret, rotateProviderSecret, storeProviderSecret } from '@/lib/money/secrets';
import type { ImageBytes } from '@/lib/ap/check-print/check-doc';

export const SIGNATURE_BUCKET = 'check-signatures';
export const MAX_SIGNATURE_BYTES = 512 * 1024;

export interface MicrNumbers {
  routing: string;
  account: string;
}

export interface CheckSecretsStore {
  storeMicr(numbers: MicrNumbers, name: string, existingRef: string | null): Promise<string>;
  readMicr(ref: string): Promise<MicrNumbers | null>;
  putSignature(path: string, bytes: Uint8Array, contentType: string): Promise<void>;
  getSignature(path: string): Promise<ImageBytes | null>;
  removeSignature(path: string): Promise<void>;
}

function parseMicr(raw: string | null): MicrNumbers | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<MicrNumbers>;
    if (typeof v.routing === 'string' && typeof v.account === 'string') return { routing: v.routing, account: v.account };
  } catch {
    /* fall through */
  }
  return null;
}

/** Sniff PNG / JPEG from the bytes (never trust the declared type). */
export function imageFormat(bytes: Uint8Array): 'png' | 'jpg' | null {
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png';
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg';
  return null;
}

/** Org-namespaced key: `<org>/<bank account>/<slot>-<random>.<ext>`. */
export function signaturePath(orgId: string, bankAccountId: string, slot: 1 | 2, format: 'png' | 'jpg'): string {
  return `${orgId}/${bankAccountId}/signature${slot}-${crypto.randomUUID()}.${format}`;
}

/** The production store: Vault + private Storage through the service-role client. */
export function supabaseCheckSecrets(admin: SupabaseClient): CheckSecretsStore {
  return {
    async storeMicr(numbers, name, existingRef) {
      const payload = JSON.stringify({ routing: numbers.routing, account: numbers.account });
      if (existingRef) {
        await rotateProviderSecret(admin, existingRef, payload);
        return existingRef;
      }
      return storeProviderSecret(admin, payload, name);
    },
    async readMicr(ref) {
      return parseMicr(await readProviderSecret(admin, ref));
    },
    async putSignature(path, bytes, contentType) {
      const { error } = await admin.storage.from(SIGNATURE_BUCKET).upload(path, bytes, { contentType, upsert: false });
      if (error) throw new Error(`Could not store the signature: ${error.message}`);
    },
    async getSignature(path) {
      const { data, error } = await admin.storage.from(SIGNATURE_BUCKET).download(path);
      if (error || !data) return null;
      const bytes = new Uint8Array(await data.arrayBuffer());
      const format = imageFormat(bytes);
      return format ? { data: Buffer.from(bytes), format } : null;
    },
    async removeSignature(path) {
      await admin.storage.from(SIGNATURE_BUCKET).remove([path]);
    },
  };
}

/** In-memory store (tests). */
export function memoryCheckSecrets(): CheckSecretsStore & { micr: Map<string, MicrNumbers>; files: Map<string, Uint8Array> } {
  const micr = new Map<string, MicrNumbers>();
  const files = new Map<string, Uint8Array>();
  return {
    micr,
    files,
    async storeMicr(numbers, _name, existingRef) {
      const ref = existingRef ?? crypto.randomUUID();
      micr.set(ref, { ...numbers });
      return ref;
    },
    async readMicr(ref) {
      return micr.get(ref) ?? null;
    },
    async putSignature(path, bytes) {
      files.set(path, bytes);
    },
    async getSignature(path) {
      const b = files.get(path);
      const format = b ? imageFormat(b) : null;
      return b && format ? { data: Buffer.from(b), format } : null;
    },
    async removeSignature(path) {
      files.delete(path);
    },
  };
}
