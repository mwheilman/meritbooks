export const dynamic = 'force-dynamic';

import { route } from '@/lib/api';
import { fsCall } from '@/lib/fieldservice/rpc';
import { applyFsCommand, FsBatchZ, type FsCommandResult } from '@/lib/fieldservice/field-commands';

/**
 * POST /api/field/fs-commands — Merit Workforce's queued field-service commands (FS-26): checklist
 * with readings, voice note, nameplate equipment, will-call pickup, the customer's pay link and a
 * text from the visit (lib/fieldservice/field-commands.ts). Each applies at most once (the client
 * command id is the idempotency key inside the same database transaction) and is guarded again in
 * its definer RPC; one result per command, in order. No money in or out.
 */
export const POST = route({ access: { cap: 'projects.jobs', action: 'view' }, mask: false, body: FsBatchZ }, async ({ db, body }) => {
  const rpc = <T,>(fn: string, args: Record<string, unknown>) => fsCall<T>(db, fn, args);
  const results: FsCommandResult[] = [];
  for (const c of body.commands) results.push(await applyFsCommand(rpc, c, new Date()));
  return { results, serverTime: new Date().toISOString() };
});
