/** Small JSON cache in SQLite (today's work, the shift in progress, settings), sealed with AES-256-GCM. */
import { database } from './db';
import { sealer } from './secure';

export async function getJson<T>(key: string, guard: (v: unknown) => v is T): Promise<{ value: T; updatedAt: number } | null> {
  try {
    const db = await database();
    const r = await db.getFirstAsync<{ value: string; updated_at: number }>('SELECT value, updated_at FROM kv WHERE key = ?', [key]);
    if (!r) return null;
    const text = await sealer.open(r.value);
    if (!text) return null;
    const v: unknown = JSON.parse(text);
    return guard(v) ? { value: v, updatedAt: r.updated_at } : null;
  } catch {
    return null;
  }
}

export async function setJson(key: string, value: unknown): Promise<void> {
  const db = await database();
  await db.runAsync('INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at', [key, await sealer.seal(JSON.stringify(value)), Date.now()]);
}
