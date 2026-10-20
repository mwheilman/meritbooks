/**
 * Production wiring for one scheduler tick: service-role store, per-org RLS-scoped
 * clients, env kill switches, and the Vercel time budget. The cron route is a thin
 * auth wrapper around `dispatchTick`.
 */

import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { createOrgScopedSupabase } from '@/lib/reports/compiler/org-scoped-client';
import { JOBS } from './registry';
import { readSchedulerEnv, runTick, type TickReport } from './run';
import { SupabaseSchedulerStore } from './store';
import type { JobContext } from './types';

/** Must stay below the route's `maxDuration` (300 s) with room to write results. */
export const TICK_BUDGET_MS = 240_000;
export const MAX_UNITS_PER_TICK = 40;
export const TICK_CONCURRENCY = 3;

export async function dispatchTick(now: Date = new Date()): Promise<TickReport> {
  const admin: SupabaseClient = createAdminSupabase();
  const store = new SupabaseSchedulerStore(admin);

  const makeContext = (args: { orgId: string | null; slotAt: Date; signal: AbortSignal; now: Date }): JobContext => {
    let scoped: SupabaseClient | null | undefined;
    return {
      orgId: args.orgId,
      now: args.now,
      slotAt: args.slotAt,
      signal: args.signal,
      admin,
      scopedClient: () => {
        if (!args.orgId) return null;
        if (scoped === undefined) scoped = createOrgScopedSupabase(args.orgId);
        return scoped;
      },
    };
  };

  return runTick({
    store,
    registry: JOBS,
    now,
    tickId: randomUUID(),
    budgetMs: TICK_BUDGET_MS,
    maxUnits: MAX_UNITS_PER_TICK,
    concurrency: TICK_CONCURRENCY,
    env: readSchedulerEnv(),
    makeContext,
  });
}
