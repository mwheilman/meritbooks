/**
 * The durable command queue. Every write the phone makes goes here FIRST (SQLite on the phone,
 * memory in tests), with its original timestamp and GPS fix, and is sent when there is a
 * connection. The server applies each command at most once (dedupe by command id), so a command
 * that was sent but whose answer was lost is simply sent again.
 *
 *   pending  → waiting to send (or waiting out a back-off after a passing failure)
 *   sending  → in flight; a crash mid-send leaves it here and recover() puts it back to pending
 *   done     → the server applied it (or already had it)
 *   rejected → the server will never apply it as sent; `result.reason` says why (shown on the phone)
 *   dismissed→ a rejection the person has read and cleared
 *
 * Pure TypeScript: storage and transport are injected (unit-tested in queue.test.ts).
 */
import { MAX_BATCH, type Command, type CommandKind, type CommandResult, type JsonCommand, type PhotoCommand } from './contract';

export type QueueStatus = 'pending' | 'sending' | 'done' | 'rejected' | 'dismissed';

export interface QueuedCommand {
  id: string;
  seq: number;
  kind: CommandKind;
  command: Command;
  status: QueueStatus;
  attempts: number;
  /** ms epoch; 0 = now. */
  nextAttemptAt: number;
  createdAt: number;
  updatedAt: number;
  lastError: string | null;
  result: CommandResult | null;
  /** Photos: the copy in the app's own storage, written before the command was queued. */
  fileUri: string | null;
  /** Another command that must reach the server first (a photo waits for its log). */
  dependsOn: string | null;
}

export interface QueueStore {
  insert(c: QueuedCommand): Promise<void>;
  update(id: string, patch: Partial<Omit<QueuedCommand, 'id' | 'seq' | 'command' | 'kind'>>): Promise<void>;
  /** Every row, in seq order. */
  all(): Promise<QueuedCommand[]>;
  maxSeq(): Promise<number>;
  remove(ids: ReadonlyArray<string>): Promise<void>;
}

export type TransportFailure = 'offline' | 'auth' | 'server' | 'client';

/** Thrown by a Transport when a whole call fails (no per-command answers). */
export class TransportError extends Error {
  constructor(message: string, readonly failure: TransportFailure) {
    super(message);
    this.name = 'TransportError';
  }
}

export interface Transport {
  sendBatch(commands: JsonCommand[]): Promise<CommandResult[]>;
  sendPhoto(command: PhotoCommand, fileUri: string): Promise<CommandResult>;
}

export interface QueueOptions {
  now?: () => number;
  batchSize?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  /** Called when a photo's row is pruned or its rejection dismissed, so its local file can be removed. */
  onFileReleased?: (uri: string) => void;
}

export interface QueueCounts {
  /** Not yet on the server (pending + sending). */
  waiting: number;
  /** Refused by the server and not yet cleared. */
  rejected: number;
  /** Waiting out a back-off after a passing failure. */
  delayed: number;
}

export interface FlushReport {
  sent: number;
  applied: number;
  duplicates: number;
  rejected: number;
  retried: number;
  /** Stopped because the phone is offline. */
  offline: boolean;
  /** Stopped because the session needs a new sign-in. */
  authProblem: boolean;
}

const OPEN: ReadonlySet<QueueStatus> = new Set(['pending', 'sending']);

export class CommandQueue {
  private readonly now: () => number;
  private readonly batchSize: number;
  private readonly base: number;
  private readonly max: number;
  private readonly listeners = new Set<() => void>();
  private flushing: Promise<FlushReport> | null = null;

  constructor(private readonly store: QueueStore, private readonly opts: QueueOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.batchSize = Math.min(Math.max(1, opts.batchSize ?? 25), MAX_BATCH);
    this.base = opts.baseBackoffMs ?? 5_000;
    this.max = opts.maxBackoffMs ?? 15 * 60_000;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  /** After an app restart: anything left "sending" by a crash goes back to pending (re-sending is safe). */
  async recover(): Promise<number> {
    const stuck = (await this.store.all()).filter((c) => c.status === 'sending');
    for (const c of stuck) await this.store.update(c.id, { status: 'pending', updatedAt: this.now() });
    if (stuck.length) this.emit();
    return stuck.length;
  }

  /** Save a command durably. Resolves only after the store has it — then the UI can say "Saved". */
  async enqueue(command: Command, opts: { fileUri?: string | null; dependsOn?: string | null } = {}): Promise<QueuedCommand> {
    const existing = (await this.store.all()).find((c) => c.id === command.id);
    if (existing) return existing;
    const t = this.now();
    const row: QueuedCommand = {
      id: command.id, seq: (await this.store.maxSeq()) + 1, kind: command.kind, command, status: 'pending', attempts: 0,
      nextAttemptAt: 0, createdAt: t, updatedAt: t, lastError: null, result: null, fileUri: opts.fileUri ?? null, dependsOn: opts.dependsOn ?? null,
    };
    await this.store.insert(row);
    this.emit();
    return row;
  }

  async list(): Promise<QueuedCommand[]> {
    return this.store.all();
  }

  async counts(): Promise<QueueCounts> {
    const all = await this.store.all();
    const t = this.now();
    return {
      waiting: all.filter((c) => OPEN.has(c.status)).length,
      rejected: all.filter((c) => c.status === 'rejected').length,
      delayed: all.filter((c) => c.status === 'pending' && c.nextAttemptAt > t).length,
    };
  }

  /** The person read a rejection: clear it from the badge (and free its photo). */
  async dismiss(id: string): Promise<void> {
    const c = (await this.store.all()).find((x) => x.id === id);
    if (!c || c.status !== 'rejected') return;
    await this.store.update(id, { status: 'dismissed', updatedAt: this.now() });
    if (c.fileUri) this.opts.onFileReleased?.(c.fileUri);
    this.emit();
  }

  /** Try a rejected command again as-is (e.g. after the office fixed a role). */
  async retry(id: string): Promise<void> {
    const c = (await this.store.all()).find((x) => x.id === id);
    if (!c || (c.status !== 'rejected' && c.status !== 'pending')) return;
    await this.store.update(id, { status: 'pending', nextAttemptAt: 0, updatedAt: this.now() });
    this.emit();
  }

  /** Remove finished rows older than `olderThanMs` (rejections stay until dismissed). */
  async prune(olderThanMs: number): Promise<number> {
    const cutoff = this.now() - olderThanMs;
    const old = (await this.store.all()).filter((c) => (c.status === 'done' || c.status === 'dismissed') && c.updatedAt < cutoff);
    if (old.length) await this.store.remove(old.map((c) => c.id));
    for (const c of old) if (c.fileUri) this.opts.onFileReleased?.(c.fileUri);
    return old.length;
  }

  private backoff(attempts: number): number {
    return Math.min(this.max, this.base * 2 ** Math.max(0, attempts - 1));
  }

  /** Ready to send now: pending, past its back-off, and not waiting on an unfinished command. */
  private ready(all: QueuedCommand[]): QueuedCommand[] {
    const t = this.now();
    const open = new Set(all.filter((c) => OPEN.has(c.status)).map((c) => c.id));
    return all.filter((c) => c.status === 'pending' && c.nextAttemptAt <= t && !(c.dependsOn && open.has(c.dependsOn)));
  }

  private async settle(c: QueuedCommand, r: CommandResult | undefined, report: FlushReport, err?: string): Promise<void> {
    const t = this.now();
    if (r && (r.outcome === 'applied' || r.outcome === 'duplicate')) {
      await this.store.update(c.id, { status: 'done', result: r, lastError: null, updatedAt: t });
      if (r.outcome === 'applied') report.applied += 1;
      else report.duplicates += 1;
      return; // a sent photo's file stays (the Photos screen shows it) until prune()
    }
    if (r && r.outcome === 'rejected') {
      await this.store.update(c.id, { status: 'rejected', result: r, lastError: r.reason ?? 'The server refused this.', updatedAt: t });
      report.rejected += 1;
      return;
    }
    const attempts = c.attempts + 1;
    await this.store.update(c.id, {
      status: 'pending', attempts, nextAttemptAt: t + this.backoff(attempts), lastError: r?.reason ?? err ?? 'Not sent yet.', updatedAt: t,
      ...(r ? { result: r } : {}),
    });
    report.retried += 1;
  }

  /**
   * Send what is ready: JSON commands in batches (oldest first), then photos one at a time.
   * Single-flight: a second call while one runs waits for the same run.
   */
  flush(transport: Transport): Promise<FlushReport> {
    this.flushing ??= this.run(transport).finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  private async run(transport: Transport): Promise<FlushReport> {
    const report: FlushReport = { sent: 0, applied: 0, duplicates: 0, rejected: 0, retried: 0, offline: false, authProblem: false };
    for (let round = 0; round < 20; round += 1) {
      const ready = this.ready(await this.store.all());
      if (!ready.length) break;
      const json = ready.filter((c) => c.kind !== 'photo.upload').slice(0, this.batchSize);
      const photos = ready.filter((c) => c.kind === 'photo.upload');
      if (!json.length && !photos.length) break;
      let stop = false;

      if (json.length) {
        for (const c of json) await this.store.update(c.id, { status: 'sending', updatedAt: this.now() });
        this.emit();
        try {
          const results = await transport.sendBatch(json.map((c) => c.command as JsonCommand));
          const byId = new Map(results.map((r) => [r.id, r]));
          report.sent += json.length;
          for (const c of json) await this.settle(c, byId.get(c.id), report, 'The server did not answer for this one.');
        } catch (e) {
          stop = await this.transportFailed(json, e, report);
        }
        this.emit();
      }

      if (!stop) {
        for (const c of photos) {
          if (!c.fileUri) {
            await this.settle(c, { id: c.id, kind: c.kind, outcome: 'rejected', code: 'PHOTO_MISSING', reason: 'The photo file is no longer on this phone. Take it again.' }, report);
            continue;
          }
          await this.store.update(c.id, { status: 'sending', updatedAt: this.now() });
          this.emit();
          try {
            const r = await transport.sendPhoto(c.command as PhotoCommand, c.fileUri);
            report.sent += 1;
            await this.settle(c, r.id ? r : { ...r, id: c.id }, report);
          } catch (e) {
            stop = await this.transportFailed([c], e, report);
          }
          this.emit();
          if (stop) break;
        }
      }
      if (stop) break;
    }
    return report;
  }

  /** A whole call failed. Returns true when the flush should stop. */
  private async transportFailed(items: QueuedCommand[], e: unknown, report: FlushReport): Promise<boolean> {
    const failure: TransportFailure = e instanceof TransportError ? e.failure : 'server';
    const message = e instanceof Error ? e.message : 'Not sent yet.';
    const t = this.now();
    if (failure === 'offline' || failure === 'auth') {
      // Nothing is wrong with the commands: put them back untouched and wait for the network / sign-in.
      for (const c of items) await this.store.update(c.id, { status: 'pending', lastError: message, updatedAt: t });
      if (failure === 'offline') report.offline = true;
      else report.authProblem = true;
      return true;
    }
    if (failure === 'client') {
      for (const c of items) await this.settle(c, { id: c.id, kind: c.kind, outcome: 'rejected', code: 'REFUSED', reason: message }, report);
      return false;
    }
    for (const c of items) await this.settle(c, undefined, report, message);
    return true;
  }
}
