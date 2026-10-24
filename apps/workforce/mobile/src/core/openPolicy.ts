/**
 * When the phone's database will not open. Deleting it loses unsent time, so it is deleted ONLY
 * on a confirmed key mismatch (SQLCipher's "file is not a database": the key that sealed it is
 * gone for good, so nothing in it can ever be read or sent). Any other failure — the key store
 * busy, the disk briefly unavailable — is retried, and if it keeps failing the app shows a
 * blocking "try again" screen and deletes nothing. Pure (unit-tested).
 */

export class OpenFailedError extends Error {
  constructor(readonly causeMessage: string) {
    super("Couldn't open your saved work.");
    this.name = 'OpenFailedError';
  }
}

/** SQLITE_NOTADB (26): the file is encrypted with a different key (or is not SQLite at all). */
export function isKeyMismatch(e: unknown): boolean {
  const msg = e instanceof Error ? `${e.message} ${(e as { code?: unknown }).code ?? ''}` : String(e);
  return /file is not a database|SQLITE_NOTADB|\bcode[:= ]+26\b|error code 26/i.test(msg);
}

export interface OpenPolicy {
  /** Extra attempts after the first for a non-mismatch failure. */
  retries?: number;
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export async function openWithRecovery<T>(open: () => Promise<T>, destroy: () => Promise<void>, policy: OpenPolicy = {}): Promise<T> {
  const retries = policy.retries ?? 2;
  const delay = policy.delayMs ?? 400;
  const sleep = policy.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let last: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await open();
    } catch (e) {
      last = e;
      if (isKeyMismatch(e)) {
        await destroy();
        try {
          return await open();
        } catch (again) {
          throw new OpenFailedError(again instanceof Error ? again.message : String(again));
        }
      }
      if (attempt < retries) await sleep(delay * (attempt + 1));
    }
  }
  throw new OpenFailedError(last instanceof Error ? last.message : String(last));
}
