import { beforeEach, describe, expect, it } from 'vitest';
import type { Command, CommandResult, JsonCommand, LogSubmitCommand, PhotoCommand } from './contract';
import { MemoryQueueStore } from './memoryStore';
import { CommandQueue, TransportError, type Transport } from './queue';

let clock = 1_000_000;
const now = () => clock;
let n = 0;
const id = () => `cccccccc-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const JOB = '33333333-3333-4333-8333-333333333333';

const log = (over: Partial<LogSubmitCommand> = {}): LogSubmitCommand => ({
  id: id(), at: '2026-10-24T15:00:00Z', geo: { lat: 41.6, lng: -93.6 }, kind: 'log.submit', jobId: JOB, logDate: '2026-10-24', body: 'Framing done', ...over,
});
const photo = (attach?: string): PhotoCommand => ({
  id: id(), at: '2026-10-24T15:01:00Z', kind: 'photo.upload', jobId: JOB, ...(attach ? { attachTo: { kind: 'log' as const, commandId: attach } } : {}),
});

/** A fake server: dedupes by command id like /api/field/sync. */
class FakeServer implements Transport {
  seen = new Set<string>();
  batches: string[][] = [];
  photos: string[] = [];
  mode: 'ok' | 'offline' | 'auth' | 'down' | 'forbidden' = 'ok';
  reject = new Map<string, string>();
  retryOnce = new Set<string>();
  async sendBatch(cmds: JsonCommand[]): Promise<CommandResult[]> {
    this.fail();
    this.batches.push(cmds.map((c) => c.id));
    return cmds.map((c) => this.answer(c));
  }
  async sendPhoto(c: PhotoCommand, uri: string): Promise<CommandResult> {
    this.fail();
    this.photos.push(uri);
    return this.answer(c);
  }
  private fail(): void {
    if (this.mode === 'offline') throw new TransportError('No connection', 'offline');
    if (this.mode === 'auth') throw new TransportError('Session expired', 'auth');
    if (this.mode === 'down') throw new TransportError('Server error 502', 'server');
    if (this.mode === 'forbidden') throw new TransportError('Your role cannot use Merit Projects on the phone.', 'client');
  }
  private answer(c: Command): CommandResult {
    if (this.retryOnce.delete(c.id)) return { id: c.id, kind: c.kind, outcome: 'retry', reason: 'Database busy' };
    const why = this.reject.get(c.id);
    if (why) return { id: c.id, kind: c.kind, outcome: 'rejected', code: 'TIME_APPROVED', reason: why };
    if (this.seen.has(c.id)) return { id: c.id, kind: c.kind, outcome: 'duplicate' };
    this.seen.add(c.id);
    return { id: c.id, kind: c.kind, outcome: 'applied', serverId: `srv-${c.id.slice(-4)}` };
  }
}

let store: MemoryQueueStore;
let q: CommandQueue;
let server: FakeServer;
let released: string[];

beforeEach(() => {
  clock = 1_000_000;
  store = new MemoryQueueStore();
  released = [];
  q = new CommandQueue(store, { now, batchSize: 3, baseBackoffMs: 1000, maxBackoffMs: 8000, onFileReleased: (u) => released.push(u) });
  server = new FakeServer();
});

describe('command queue', () => {
  it('saves durably with the original timestamp and GPS, counts what is waiting, and sends in order', async () => {
    const a = log();
    const b = log({ body: 'Second' });
    await q.enqueue(a);
    await q.enqueue(b);
    expect(await q.counts()).toEqual({ waiting: 2, rejected: 0, delayed: 0 });
    const saved = (await store.all())[0]!;
    expect(saved.command).toMatchObject({ at: '2026-10-24T15:00:00Z', geo: { lat: 41.6, lng: -93.6 } });
    const r = await q.flush(server);
    expect(r).toMatchObject({ sent: 2, applied: 2, rejected: 0 });
    expect(server.batches).toEqual([[a.id, b.id]]);
    expect(await q.counts()).toEqual({ waiting: 0, rejected: 0, delayed: 0 });
  });

  it('enqueueing the same command id twice keeps one copy', async () => {
    const a = log();
    await q.enqueue(a);
    await q.enqueue(a);
    expect((await store.all()).length).toBe(1);
  });

  it('pages large queues by the batch size', async () => {
    for (let i = 0; i < 7; i += 1) await q.enqueue(log());
    await q.flush(server);
    expect(server.batches.map((b) => b.length)).toEqual([3, 3, 1]);
  });

  it('offline: nothing is lost, nothing is counted as a failed attempt, and it all sends later', async () => {
    await q.enqueue(log());
    server.mode = 'offline';
    const r = await q.flush(server);
    expect(r.offline).toBe(true);
    const [row] = await store.all();
    expect(row).toMatchObject({ status: 'pending', attempts: 0, nextAttemptAt: 0 });
    server.mode = 'ok';
    expect((await q.flush(server)).applied).toBe(1);
  });

  it('expired session: stops and keeps everything for after the sign-in', async () => {
    await q.enqueue(log());
    server.mode = 'auth';
    expect((await q.flush(server)).authProblem).toBe(true);
    expect((await q.counts()).waiting).toBe(1);
  });

  it('server trouble backs off exponentially, capped', async () => {
    await q.enqueue(log());
    server.mode = 'down';
    await q.flush(server);
    let [row] = await store.all();
    expect(row).toMatchObject({ status: 'pending', attempts: 1, nextAttemptAt: clock + 1000 });
    expect((await q.counts()).delayed).toBe(1);
    expect((await q.flush(server)).sent).toBe(0); // still backing off
    for (const expected of [2000, 4000, 8000, 8000]) {
      clock = row!.nextAttemptAt;
      await q.flush(server);
      [row] = await store.all();
      expect(row!.nextAttemptAt - clock).toBe(expected);
    }
    server.mode = 'ok';
    clock = row!.nextAttemptAt;
    expect((await q.flush(server)).applied).toBe(1);
  });

  it('a per-command retry backs off that command only', async () => {
    const a = log();
    const b = log();
    await q.enqueue(a);
    await q.enqueue(b);
    server.retryOnce.add(a.id);
    const r = await q.flush(server);
    expect(r).toMatchObject({ applied: 1, retried: 1 });
    const rows = await store.all();
    expect(rows.find((x) => x.id === a.id)).toMatchObject({ status: 'pending', attempts: 1, lastError: 'Database busy' });
    clock += 1000;
    expect((await q.flush(server)).applied).toBe(1);
  });

  it('a lost answer is safe: the re-send comes back duplicate and the command is done', async () => {
    const a = log();
    await q.enqueue(a);
    server.seen.add(a.id); // the server applied it but the phone never heard back
    const r = await q.flush(server);
    expect(r).toMatchObject({ duplicates: 1, applied: 0 });
    expect((await store.all())[0]!.status).toBe('done');
  });

  it('a rejection is final, keeps the server’s reason, and is cleared only by the person', async () => {
    const a = log();
    await q.enqueue(a);
    server.reject.set(a.id, 'Your supervisor already approved this time.');
    await q.flush(server);
    expect(await q.counts()).toEqual({ waiting: 0, rejected: 1, delayed: 0 });
    const row = (await store.all())[0]!;
    expect(row.result?.reason).toBe('Your supervisor already approved this time.');
    expect((await q.flush(server)).sent).toBe(0); // never re-sent on its own
    await q.dismiss(a.id);
    expect((await q.counts()).rejected).toBe(0);
  });

  it('try again re-sends a rejected command', async () => {
    const a = log();
    await q.enqueue(a);
    server.reject.set(a.id, 'nope');
    await q.flush(server);
    server.reject.clear();
    await q.retry(a.id);
    expect((await q.flush(server)).applied).toBe(1);
  });

  it('a whole-call refusal (e.g. 403 role) rejects that batch with the reason', async () => {
    await q.enqueue(log());
    server.mode = 'forbidden';
    await q.flush(server);
    expect((await store.all())[0]).toMatchObject({ status: 'rejected', lastError: 'Your role cannot use Merit Projects on the phone.' });
  });

  it('a photo waits for the log it belongs to, uploads from the local file, and frees the file when pruned', async () => {
    const l = log();
    const p = photo(l.id);
    await q.enqueue(p, { fileUri: 'file:///photos/p1.jpg', dependsOn: l.id });
    await q.enqueue(l);
    server.mode = 'down';
    await q.flush(server);
    expect(server.photos).toEqual([]); // the log failed, so the photo did not jump ahead
    server.mode = 'ok';
    clock += 1000;
    await q.flush(server);
    expect(server.batches.at(-1)).toEqual([l.id]);
    expect(server.photos).toEqual(['file:///photos/p1.jpg']);
    expect(released).toEqual([]);
    clock += 8 * 86_400_000;
    await q.prune(7 * 86_400_000);
    expect(released).toEqual(['file:///photos/p1.jpg']);
  });

  it('a photo whose log was refused still uploads (the server files it on the job)', async () => {
    const l = log();
    await q.enqueue(l);
    await q.enqueue(photo(l.id), { fileUri: 'file:///photos/p2.jpg', dependsOn: l.id });
    server.reject.set(l.id, 'Job closed');
    await q.flush(server);
    expect(server.photos).toEqual(['file:///photos/p2.jpg']);
  });

  it('a photo with no local file is refused on the phone with a plain reason', async () => {
    await q.enqueue(photo());
    await q.flush(server);
    expect((await store.all())[0]).toMatchObject({ status: 'rejected', lastError: 'The photo file is no longer on this phone. Take it again.' });
  });

  it('after a crash mid-send, recover() puts in-flight commands back and they send once', async () => {
    const a = log();
    await q.enqueue(a);
    await store.update(a.id, { status: 'sending' });
    expect(await q.recover()).toBe(1);
    await q.flush(server);
    await q.flush(server);
    expect(server.batches.flat()).toEqual([a.id]);
  });

  it('flush is single-flight', async () => {
    await q.enqueue(log());
    const [r1, r2] = await Promise.all([q.flush(server), q.flush(server)]);
    expect(r1).toBe(r2);
    expect(server.batches.length).toBe(1);
  });

  it('prune drops old finished rows and keeps rejections', async () => {
    const a = log();
    const b = log();
    await q.enqueue(a);
    await q.enqueue(b);
    server.reject.set(b.id, 'no');
    await q.flush(server);
    clock += 8 * 86_400_000;
    expect(await q.prune(7 * 86_400_000)).toBe(1);
    expect((await store.all()).map((r) => r.id)).toEqual([b.id]);
  });

  it('notifies listeners so the "All saved / 3 waiting" badge updates', async () => {
    let calls = 0;
    const off = q.subscribe(() => { calls += 1; });
    await q.enqueue(log());
    await q.flush(server);
    off();
    expect(calls).toBeGreaterThanOrEqual(2);
  });
});
