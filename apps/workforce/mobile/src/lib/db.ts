/**
 * The phone's own database (expo-sqlite): the durable command queue and a small key-value cache
 * (today's work, my week, the shift in progress, settings).
 *
 * Encrypted at rest two ways (lib/secure.ts): the whole file with SQLCipher (`useSQLCipher` in
 * app.json; raw 256-bit key from the platform key store) and, inside it, every payload column
 * sealed with AES-256-GCM — so it is encrypted in Expo Go too, where SQLCipher is not available.
 * WAL, so a write is on disk before the UI says "Saved".
 */
import * as SQLite from 'expo-sqlite';
import { Directory, Paths } from 'expo-file-system';
import { openWithRecovery } from '@/core/openPolicy';
import { databaseKeyHex, forgetStorageKey } from './secure';

const NAME = 'merit-workforce.db';

const SCHEMA = `
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS commands (
  id TEXT PRIMARY KEY NOT NULL,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  command TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_error TEXT,
  result TEXT,
  file_uri TEXT,
  depends_on TEXT
);
CREATE INDEX IF NOT EXISTS commands_status_idx ON commands (status, seq);
CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

let opening: Promise<SQLite.SQLiteDatabase> | null = null;

async function openKeyed(): Promise<SQLite.SQLiteDatabase> {
  const key = await databaseKeyHex();
  const db = await SQLite.openDatabaseAsync(NAME);
  try {
    // Must be the first statement on the connection. Plain SQLite (Expo Go) ignores it.
    await db.execAsync(`PRAGMA key = "x'${key}'";`);
    await db.execAsync(SCHEMA); // throws "file is not a database" when the key does not match the file
    return db;
  } catch (e) {
    await db.closeAsync().catch(() => undefined);
    throw e;
  }
}

export function database(): Promise<SQLite.SQLiteDatabase> {
  // Deleted ONLY on a confirmed key mismatch; other failures retry, then throw OpenFailedError
  // (the app shows "Couldn't open your saved work — try again" and deletes nothing).
  opening ??= openWithRecovery(openKeyed, () => SQLite.deleteDatabaseAsync(NAME)).catch((e: unknown) => {
    opening = null;
    throw e;
  });
  return opening;
}

/** Signed out: delete the database, the photos and the key (another person may use the phone next). */
export async function wipeLocalData(): Promise<void> {
  const current = opening;
  opening = null;
  if (current) await current.then((db) => db.closeAsync()).catch(() => undefined);
  await SQLite.deleteDatabaseAsync(NAME).catch(() => undefined);
  try {
    const photos = new Directory(Paths.document, 'photos');
    if (photos.exists) photos.delete();
  } catch {
    // nothing to delete
  }
  await forgetStorageKey();
}
