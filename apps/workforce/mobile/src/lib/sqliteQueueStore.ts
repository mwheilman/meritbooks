/**
 * QueueStore on expo-sqlite: one row per command. The command (GPS, notes, signature), the server's
 * answer and the last error are sealed with AES-256-GCM (lib/secure.ts); only the routing columns
 * (id, order, kind, status, timers, file path) are plain, so the queue can be read without decrypting.
 */
import type { Command, CommandKind, CommandResult } from '@/core/contract';
import type { QueuedCommand, QueueStatus, QueueStore } from '@/core/queue';
import { database } from './db';
import { sealer } from './secure';

interface Row {
  id: string;
  seq: number;
  kind: string;
  command: string;
  status: string;
  attempts: number;
  next_attempt_at: number;
  created_at: number;
  updated_at: number;
  last_error: string | null;
  result: string | null;
  file_uri: string | null;
  depends_on: string | null;
}

const COLUMN: Readonly<Record<string, string>> = {
  status: 'status', attempts: 'attempts', nextAttemptAt: 'next_attempt_at', createdAt: 'created_at', updatedAt: 'updated_at',
  lastError: 'last_error', result: 'result', fileUri: 'file_uri', dependsOn: 'depends_on',
};

async function openJson<T>(sealed: string | null): Promise<T | null> {
  const text = await sealer.open(sealed);
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

const sealJson = (v: unknown) => sealer.seal(JSON.stringify(v));

/** A row whose command cannot be opened (wrong key) is skipped: it cannot be sent anyway. */
async function toQueued(r: Row): Promise<QueuedCommand | null> {
  const command = await openJson<Command>(r.command);
  if (!command) return null;
  return {
    id: r.id, seq: r.seq, kind: r.kind as CommandKind, command, status: r.status as QueueStatus, attempts: r.attempts,
    nextAttemptAt: r.next_attempt_at, createdAt: r.created_at, updatedAt: r.updated_at, lastError: await sealer.open(r.last_error),
    result: await openJson<CommandResult>(r.result), fileUri: r.file_uri, dependsOn: r.depends_on,
  };
}

export class SqliteQueueStore implements QueueStore {
  async insert(c: QueuedCommand): Promise<void> {
    const db = await database();
    await db.runAsync(
      `INSERT OR IGNORE INTO commands (id, seq, kind, command, status, attempts, next_attempt_at, created_at, updated_at, last_error, result, file_uri, depends_on)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        c.id, c.seq, c.kind, await sealJson(c.command), c.status, c.attempts, c.nextAttemptAt, c.createdAt, c.updatedAt,
        c.lastError ? await sealer.seal(c.lastError) : null, c.result ? await sealJson(c.result) : null, c.fileUri, c.dependsOn,
      ],
    );
  }

  async update(id: string, patch: Partial<QueuedCommand>): Promise<void> {
    const sets: string[] = [];
    const values: Array<string | number | null> = [];
    for (const [k, v] of Object.entries(patch)) {
      const col = COLUMN[k];
      if (!col || v === undefined) continue;
      sets.push(`${col} = ?`);
      if (k === 'result') values.push(v ? await sealJson(v) : null);
      else if (k === 'lastError') values.push(v ? await sealer.seal(String(v)) : null);
      else values.push(v as string | number | null);
    }
    if (!sets.length) return;
    const db = await database();
    await db.runAsync(`UPDATE commands SET ${sets.join(', ')} WHERE id = ?`, [...values, id]);
  }

  async all(): Promise<QueuedCommand[]> {
    const db = await database();
    const rows = await db.getAllAsync<Row>('SELECT * FROM commands ORDER BY seq');
    const out = await Promise.all(rows.map(toQueued));
    return out.filter((x): x is QueuedCommand => !!x);
  }

  async maxSeq(): Promise<number> {
    const db = await database();
    const r = await db.getFirstAsync<{ m: number | null }>('SELECT MAX(seq) AS m FROM commands');
    return r?.m ?? 0;
  }

  async remove(ids: ReadonlyArray<string>): Promise<void> {
    if (!ids.length) return;
    const db = await database();
    await db.runAsync(`DELETE FROM commands WHERE id IN (${ids.map(() => '?').join(',')})`, [...ids]);
  }
}
