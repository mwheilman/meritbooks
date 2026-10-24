/** In-memory QueueStore (tests, and the fallback if SQLite cannot open). Same contract as the SQLite store. */
import type { QueuedCommand, QueueStore } from './queue';

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

export class MemoryQueueStore implements QueueStore {
  private rows = new Map<string, QueuedCommand>();

  async insert(c: QueuedCommand): Promise<void> {
    if (this.rows.has(c.id)) return;
    this.rows.set(c.id, clone(c));
  }

  async update(id: string, patch: Partial<QueuedCommand>): Promise<void> {
    const r = this.rows.get(id);
    if (r) this.rows.set(id, { ...r, ...clone(patch) });
  }

  async all(): Promise<QueuedCommand[]> {
    return [...this.rows.values()].sort((a, b) => a.seq - b.seq).map((r) => clone(r));
  }

  async maxSeq(): Promise<number> {
    let m = 0;
    for (const r of this.rows.values()) m = Math.max(m, r.seq);
    return m;
  }

  async remove(ids: ReadonlyArray<string>): Promise<void> {
    for (const id of ids) this.rows.delete(id);
  }
}
