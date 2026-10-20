/**
 * `dealer.controls_nightly` — Dealer Pack exception detectors (FPB-dealer-pack §6,
 * DL-1…DL-13 except DL-9, which D1 raises at the API).
 *
 * Detect-only: every detector queues / refreshes / expires PROPOSED ai_decisions rows
 * for clients with the pack enabled and never posts, voids, approves or releases
 * anything. Runs on the per-org RLS-scoped client (fail closed when it can't be
 * minted), with the same summary shape as `controls.nightly`.
 *
 * REGISTRATION (lead — registry.ts is reserved spine): add `DEALER_CONTROLS_JOB` to
 * JOBS in lib/scheduler/registry.ts.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { DEALER_DETECTORS, loadDealerClients } from '@/lib/controls/dealer';
import type { JobContext, JobDefinition, JobResult } from '../types';
import { runDetectors } from './controls-nightly';
import { scopedOrFail } from './shared';

export async function runDealerControlsJob(ctx: JobContext): Promise<JobResult> {
  const s = scopedOrFail(ctx);
  if (!s.ok) return s.result;
  let clients: number;
  try {
    clients = (await loadDealerClients(s.db, s.orgId)).length;
  } catch (e) {
    return { status: 'failed', error: e instanceof Error ? e.message : String(e) };
  }
  if (clients === 0) return { status: 'skipped', summary: 'No client has the dealer pack enabled.' };
  const detectors = DEALER_DETECTORS.map((d) => ({
    key: d.key,
    run: (db: SupabaseClient, orgId: string) => d.run(db, orgId, { signal: ctx.signal }),
  }));
  const result = await runDetectors(s.db, s.orgId, detectors, ctx.signal);
  return {
    ...result,
    counts: { ...(result.counts ?? {}), clients },
    summary: `Dealer checks for ${clients} client(s): ${result.summary ?? ''}`.trim(),
  };
}

export const DEALER_CONTROLS_JOB: JobDefinition = {
  key: 'dealer.controls_nightly',
  label: 'Dealer pack exception checks',
  description:
    'Runs the dealer exception checks (sold out of trust, curtailments, floor-plan and subledger tie-out, aged units, warranty and incentive aging, lender statement variance, line utilization, trade-in risk, demos on floor plan, double-recorded flooring) for every client with the dealer pack on. Detect-only: it queues exceptions for people and never posts.',
  scope: 'org',
  cron: '15 9 * * *', // nightly, ~03:15–04:15 CT, after controls.nightly
  defaultEnabled: true,
  implemented: true,
  ownerCapability: 'dealer.floor_plan',
  owner: 'Dealer pack (FPB-dealer-pack §6)',
  postsToGl: false,
  timeoutMs: 120_000,
  maxLatenessMinutes: 12 * 60,
  maxAttempts: 2,
  run: runDealerControlsJob,
};
