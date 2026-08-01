/**
 * Shared authorization guard for the event-drain workers
 * (billing/progress/dept-invoice `.../process`). These are session-less queue
 * drains that run on the admin client and post money (AR invoices, rev-rec,
 * intercompany eliminating entries), so the trigger MUST NOT be invokable by an
 * arbitrary anonymous caller.
 *
 * Two accepted callers — everyone else gets 401:
 *   1. An authenticated Clerk session (preserves the existing billing/progress
 *      guard; brings dept-invoice up to the same bar).
 *   2. A trusted server-to-server caller (cron/scheduler) presenting the shared
 *      secret in the `x-event-worker-secret` header, compared in CONSTANT TIME.
 *
 * FAILS CLOSED: if EVENT_WORKER_SECRET is unset/empty the secret path is disabled
 * entirely, so an attacker cannot authenticate by sending an empty/absent header
 * against an empty env value. With no session and no valid secret → not ok → 401.
 */

import { auth } from '@clerk/nextjs/server';
import { timingSafeEqual } from 'node:crypto';

/** Constant-time compare that never throws on a length mismatch. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export interface WorkerAuth {
  ok: boolean;
  /** The Clerk user id when authorized via session; null for the cron/secret path. */
  userId: string | null;
}

export async function authorizeEventWorker(req: Request): Promise<WorkerAuth> {
  // Path 1 — an authenticated Clerk session (the existing guard). Never weakened.
  const { userId } = await auth().catch(() => ({ userId: null as string | null }));
  if (userId) return { ok: true, userId };

  // Path 2 — trusted server-to-server caller (cron) with the shared secret.
  const secret = process.env.EVENT_WORKER_SECRET;
  const presented = req.headers.get('x-event-worker-secret');
  if (secret && secret.length > 0 && presented && safeEqual(presented, secret)) {
    return { ok: true, userId: null };
  }

  // Fail closed.
  return { ok: false, userId: null };
}
