/**
 * Shared authorization guard for the event-drain workers
 * (billing/progress/dept-invoice `.../process`). These drains run on the admin
 * client and post money (AR invoices, rev-rec, intercompany eliminating entries),
 * so who may trigger them — and over WHICH tenants — is the whole question.
 *
 * Two accepted callers — everyone else is refused:
 *   1. A trusted server-to-server caller (cron/scheduler) presenting the shared
 *      secret in the `x-event-worker-secret` header, compared in CONSTANT TIME.
 *      This is the ONLY caller allowed to process / peek ACROSS tenants
 *      (`scope: 'all'`, `orgId: null`).
 *   2. A signed-in Clerk user. They are authorized ONLY for their own verified
 *      tenant (resolved from the Clerk-signed org claim via requirePermission — no
 *      first-org fallback) and must hold the permission for the action:
 *      `journal_entries:view` to peek the queue, `journal_entries:post` to drain
 *      it (a drain posts to the GL). Routes MUST pass `orgId` into the processor
 *      and filter GET reads by it, so a member can never see or post another
 *      tenant's events. (Security HIGH: previously ANY session drained/peeked ALL
 *      tenants' events.)
 *
 * FAILS CLOSED: if EVENT_WORKER_SECRET is unset/empty the secret path is disabled
 * entirely, so an attacker cannot authenticate by sending an empty/absent header
 * against an empty env value.
 *
 * NOTE (middleware): `/api/events/*` is NOT in middleware.ts `isPublicRoute`, so
 * `auth.protect()` currently rejects a session-less cron request before it reaches
 * this guard. Making the secret path reachable requires adding the three
 * `/api/events/.../process` paths to isPublicRoute (safe: this guard fails closed).
 */

import { NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { requirePermission } from '@/lib/rbac/require-permission';

/** Constant-time compare that never throws on a length mismatch. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export type WorkerAuth =
  /** Cron/secret caller — cross-tenant. */
  | { ok: true; scope: 'all'; userId: null; orgId: null }
  /** Signed-in member — confined to their own verified tenant. */
  | { ok: true; scope: 'org'; userId: string; orgId: string }
  | { ok: false; response: NextResponse };

/** `peek` = read the queue (GET); `drain` = process/post it (POST). */
export type WorkerIntent = 'peek' | 'drain';

export async function authorizeEventWorker(req: Request, intent: WorkerIntent): Promise<WorkerAuth> {
  // Path 1 — trusted server-to-server caller (cron) with the shared secret.
  const secret = process.env.EVENT_WORKER_SECRET;
  const presented = req.headers.get('x-event-worker-secret');
  if (secret && secret.length > 0 && presented && safeEqual(presented, secret)) {
    return { ok: true, scope: 'all', userId: null, orgId: null };
  }

  // Path 2 — a signed-in member, confined to their own tenant + permission-gated.
  const { requireAuth } = await import('@/lib/api-handler');
  const authRes = await requireAuth();
  if (authRes instanceof NextResponse) {
    return { ok: false, response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  }
  const guard = await requirePermission(authRes.userId, 'journal_entries', intent === 'drain' ? 'post' : 'view');
  if (!guard.ok) return { ok: false, response: guard.response };
  return { ok: true, scope: 'org', userId: authRes.userId, orgId: guard.orgId };
}
