/**
 * Files the phone keeps in its own private storage, deleted on sign-out with the rest of the app's
 * data (lib/db.ts wipeLocalData). At rest (security review L7): iOS files get the strongest class,
 * NSFileProtectionComplete (app.json entitlement com.apple.developer.default-data-protection —
 * unreadable while the phone is locked); Android keeps them in app-private internal storage under
 * the device's file-based encryption, excluded from backups (allowBackup false). They are NOT
 * additionally sealed by the app: the PDF viewer and the upload need plain files, and a per-file
 * app key would only move the key next to the file. The database and its payloads are sealed.
 *   drawings/<revision id>.pdf   the current drawing set of my jobs (core/drawings.ts plans it)
 *   signing/<envelope id>.pdf    the document a customer is signing on this phone
 *   photos/<command id>.png      a drawn customer signature waiting to upload (photo queue)
 * Opening a PDF uses the platform viewer (iOS Quick Look, Android's PDF app) — no network needed.
 */
import { Directory, File, Paths } from 'expo-file-system';
import { sheetFileName } from '@/core/drawings';

export const DRAWINGS_DIR = 'drawings';
export const SIGNING_DIR = 'signing';

function dir(name: string): Directory {
  const d = new Directory(Paths.document, name);
  if (!d.exists) d.create({ intermediates: true, idempotent: true });
  return d;
}

export function sheetFile(revisionId: string): File | null {
  const name = sheetFileName(revisionId);
  return name ? new File(dir(DRAWINGS_DIR), name) : null;
}

export function sheetOnDisk(revisionId: string): boolean {
  try {
    return sheetFile(revisionId)?.exists ?? false;
  } catch {
    return false;
  }
}

/** Download one sheet to its revision file. Resolves false (and leaves nothing half-written) on failure. */
export async function saveSheet(revisionId: string, url: string): Promise<boolean> {
  const f = sheetFile(revisionId);
  if (!f || !/^https:\/\//.test(url)) return false;
  try {
    const got = await File.downloadFileAsync(url, f, { idempotent: true });
    if (!got.exists || (got.size ?? 0) === 0) {
      removeFile(got.uri);
      return false;
    }
    return true;
  } catch {
    removeFile(f.uri);
    return false;
  }
}

export function removeSheet(revisionId: string): void {
  const f = sheetFile(revisionId);
  if (f) removeFile(f.uri);
}

export function removeFile(uri: string): void {
  try {
    const f = new File(uri);
    if (f.exists) f.delete();
  } catch {
    // already gone
  }
}

/** Open PDFs in the platform viewer (several at once on iOS: swipe through the set). */
export async function openPdfs(revisionIds: ReadonlyArray<string>): Promise<{ ok: true } | { ok: false; reason: string }> {
  const files = revisionIds.map((r) => sheetFile(r)).filter((f): f is File => !!f && f.exists);
  if (!files.length) return { ok: false, reason: 'not on this phone' };
  try {
    if (files.length === 1) await files[0]!.preview({ mimeType: 'application/pdf' });
    else await File.preview(files);
    return { ok: true };
  } catch (e) {
    // Android previews one file at a time
    try {
      await files[0]!.preview({ mimeType: 'application/pdf' });
      return { ok: true };
    } catch {
      return { ok: false, reason: e instanceof Error ? e.message : 'no viewer' };
    }
  }
}

/** The document being signed: downloaded once (needs signal), then readable offline. */
export async function saveSigningDoc(envelopeId: string, url: string): Promise<File | null> {
  if (!/^[0-9a-f-]{36}$/i.test(envelopeId) || !/^https:\/\//.test(url)) return null;
  const f = new File(dir(SIGNING_DIR), `${envelopeId.toLowerCase()}.pdf`);
  try {
    const got = await File.downloadFileAsync(url, f, { idempotent: true });
    return got.exists && (got.size ?? 0) > 0 ? got : null;
  } catch {
    removeFile(f.uri);
    return null;
  }
}

export async function openFile(f: File): Promise<boolean> {
  try {
    await f.preview({ mimeType: 'application/pdf' });
    return true;
  } catch {
    return false;
  }
}

/** A drawn signature (base64 PNG) written as photos/<command id>.png before it is queued. */
export async function writeSignaturePng(commandId: string, base64: string): Promise<string | null> {
  if (!/^[0-9a-f-]{36}$/i.test(commandId)) return null;
  // a write refused while the phone locks (iOS file protection) is tried again a moment later
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const f = new File(dir('photos'), `${commandId.toLowerCase()}.png`);
      if (f.exists) f.delete();
      f.create();
      await f.write(base64.replace(/^data:image\/png;base64,/, ''), { encoding: 'base64' });
      return f.uri;
    } catch {
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  return null;
}
