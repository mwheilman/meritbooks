/**
 * Dealer technician clock per repair-order line (DLR-47) and the 3C story (DLR-48). The server's
 * snapshot says what I was clocked on when it was loaded; taps made since on this phone (queued or
 * sent after that snapshot) apply on top, so the banner is right with no signal. Pure (unit-tested).
 */
import type { RoBundle, RoClockCommand, RoIndirect, RoLineStoryCommand, RoStoryCommand } from './contract';
import type { QueuedCommand } from './queue';

export interface RoPunch {
  companyId: string;
  lineId: string | null;
  kind: 'LINE' | RoIndirect;
  since: string;
  /** Not yet on the server. */
  waiting: boolean;
}

const KEPT = new Set(['pending', 'sending', 'done']);

export function currentPunch(bundle: Pick<RoBundle, 'open' | 'serverTime'> | null, queued: ReadonlyArray<QueuedCommand>): RoPunch | null {
  let p: RoPunch | null = bundle?.open
    ? { companyId: bundle.open.companyId, lineId: bundle.open.lineId, kind: bundle.open.kind as RoPunch['kind'], since: bundle.open.startedAt, waiting: false }
    : null;
  const after = bundle?.serverTime ? Date.parse(bundle.serverTime) : 0;
  const mine = queued
    .filter((q) => q.command.kind === 'ro.clock' && KEPT.has(q.status) && (q.status !== 'done' || Date.parse(q.command.at) > after))
    .sort((a, b) => a.seq - b.seq);
  for (const q of mine) {
    const c = q.command as RoClockCommand;
    const waiting = q.status !== 'done';
    if (c.op === 'clock_on') p = { companyId: c.companyId, lineId: c.lineId ?? null, kind: 'LINE', since: c.at, waiting };
    else if (c.op === 'indirect') p = { companyId: c.companyId, lineId: null, kind: c.indirectKind ?? 'SHOP', since: c.at, waiting };
    else p = null;
  }
  return p;
}

export function roClockDraft(op: RoClockCommand['op'], companyId: string, extra: { lineId?: string; indirectKind?: RoIndirect } = {}): Omit<RoClockCommand, 'id' | 'at' | 'tz' | 'geo' | 'offline'> {
  return { kind: 'ro.clock', op, companyId, lineId: extra.lineId ?? null, indirectKind: extra.indirectKind ?? null };
}

export interface Story {
  complaint: string;
  cause: string;
  correction: string;
}

export const storyReady = (s: Story) => !!(s.complaint.trim() || s.cause.trim() || s.correction.trim());

/** The story goes on one RO line (POST /api/field/ro/story). A part left empty is left as it is on the server. */
export function storyDraft(workOrderId: string, lineId: string, s: Story): Omit<RoLineStoryCommand, 'id' | 'at' | 'tz' | 'geo' | 'offline'> {
  const t = (x: string) => x.trim() || null;
  return { kind: 'ro.line.story', workOrderId, lineId, complaint: t(s.complaint), cause: t(s.cause), correction: t(s.correction) };
}

/** The line a story defaults to: the one I am clocked on (on this RO), else the RO's first line. */
export function storyLine(workOrderId: string, lines: RoBundle['lines'], punch: Pick<RoPunch, 'lineId'> | null): string | null {
  const mine = lines.filter((l) => l.workOrderId === workOrderId);
  return mine.find((l) => l.id === punch?.lineId)?.id ?? mine[0]?.id ?? null;
}

/** Clock taps the office refused (stale, ahead of the real time, overlapping) — shown, never retried. */
export function refusedTaps(queued: ReadonlyArray<QueuedCommand>): Array<{ id: string; at: string; reason: string }> {
  return queued
    .filter((q) => q.command.kind === 'ro.clock' && q.status === 'rejected')
    .map((q) => ({ id: q.id, at: q.command.at, reason: q.result?.reason ?? q.lastError ?? '' }));
}

/** Stories saved on this phone for an RO (newest first), to show under it. */
export function storiesFor(workOrderId: string, queued: ReadonlyArray<QueuedCommand>): Array<{ id: string; at: string; waiting: boolean; story: RoStoryCommand | RoLineStoryCommand }> {
  return queued
    .filter((q) => (q.command.kind === 'ro.story' || q.command.kind === 'ro.line.story') && q.command.workOrderId === workOrderId && KEPT.has(q.status))
    .map((q) => ({ id: q.id, at: q.command.at, waiting: q.status !== 'done', story: q.command as RoStoryCommand | RoLineStoryCommand }))
    .sort((a, b) => b.at.localeCompare(a.at));
}

export function isRoBundle(v: unknown): v is RoBundle {
  return typeof v === 'object' && v !== null && Array.isArray((v as RoBundle).ros) && Array.isArray((v as RoBundle).lines) && Array.isArray((v as RoBundle).stores);
}
