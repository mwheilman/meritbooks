/**
 * `requests.remind` — the request & chase engine's scheduled cycle (IA M-7 / M-12;
 * FPB-request-engine-notifications §4). Every 15 minutes, per tenant:
 *
 *   1. vendor sync   open W-9 / COI requests for lapsed or expiring documents — only when
 *                    the tenant switched "Create automatically" on (default off, D1)
 *   2. dispatch      resolvers close what's already answered; due asks go out on their
 *                    cadence, respecting quiet hours; escalations notify a person
 *
 * Sends email (Resend) and writes in-app notifications. Never touches the GL.
 *
 * TENANCY: like the event drains, the engine runs on the service role with EVERY read and
 * write pinned to ctx.orgId (lib/requests/dispatch.ts) — it never relies on RLS, so it
 * also sees client-scoped requests under 163's enforce mode.
 *
 * REGISTRATION (lead — registry.ts is shared spine): replace the `requests.remind` stub
 * with `REQUESTS_DISPATCH_JOB` (cron every 15 minutes). No autonomy feature: no GL effect.
 */

import { defaultChannels, outboundAppUrl } from '@/lib/notify/channels';
import { dispatchDueRequests, type EngineDeps } from '@/lib/requests/dispatch';
import { loadPolicyContext } from '@/lib/requests/policy';
import { syncVendorComplianceRequests } from '@/lib/requests/vendor-compliance';
import { DEFAULT_RESOLVERS, type ResolverRegistry } from '@/lib/requests/resolvers';
import { dunningResolver } from '@/lib/collections/dunning-requests';
import type { JobContext, JobDefinition, JobResult } from '../types';

/**
 * The scheduled cycle's resolvers: the engine defaults (W-9 / COI, …) plus the dunning
 * resolver (a reminder for an invoice that got paid closes itself before it is sent).
 * Built at call time so resolvers other slices add to DEFAULT_RESOLVERS are kept.
 */
export function schedulerResolvers(): ResolverRegistry {
  return { ...DEFAULT_RESOLVERS, dunning: DEFAULT_RESOLVERS.dunning ?? dunningResolver };
}

export async function runRequestsDispatchJob(ctx: JobContext, overrides: Partial<EngineDeps> = {}): Promise<JobResult> {
  if (!ctx.orgId) return { status: 'skipped', summary: 'This job runs per tenant.' };
  const orgId = ctx.orgId;
  const deps: EngineDeps = {
    db: ctx.admin,
    channels: defaultChannels(),
    now: () => ctx.now,
    appUrl: outboundAppUrl(),
    signal: ctx.signal,
    resolvers: schedulerResolvers(),
    ...overrides,
  };

  let sync = { created: 0, alreadyOpen: 0, errors: [] as string[], enabled: false };
  try {
    const policyCtx = await loadPolicyContext(deps.db, orgId);
    sync = await syncVendorComplianceRequests(deps, orgId, { ctx: policyCtx });
  } catch (e) {
    sync.errors.push(`vendor sync: ${e instanceof Error ? e.message : String(e)}`);
  }

  let s;
  try {
    s = await dispatchDueRequests(deps, orgId);
  } catch (e) {
    return { status: 'failed', error: e instanceof Error ? e.message : String(e), counts: { created: sync.created } };
  }

  const errors = [...sync.errors, ...s.errors];
  const worked = sync.created + s.sent + s.fulfilled + s.expired + s.deferred + s.escalated + s.undeliverable;
  const status: JobResult['status'] = errors.length === 0 ? (worked === 0 && s.examined === 0 ? 'skipped' : 'ok') : worked > 0 ? 'partial' : 'failed';
  return {
    status,
    itemsProcessed: s.examined + sync.created,
    counts: {
      created: sync.created,
      examined: s.examined,
      sent: s.sent,
      fulfilled: s.fulfilled,
      expired: s.expired,
      deferred: s.deferred,
      escalated: s.escalated,
      failed: s.failed,
      undeliverable: s.undeliverable,
      vendor_auto_create: sync.enabled,
    },
    summary:
      worked === 0 && s.examined === 0
        ? 'Nothing due.'
        : `${s.sent} ask(s) sent, ${s.fulfilled} closed as answered, ${s.escalated} escalated, ${s.deferred} held for quiet hours${sync.created ? `, ${sync.created} new vendor request(s)` : ''}.`,
    error: errors.length ? errors.slice(0, 10).join('; ') : undefined,
  };
}

export const REQUESTS_DISPATCH_JOB: JobDefinition = {
  key: 'requests.remind',
  label: 'Request reminders',
  description:
    'Sends due request reminders (vendor W-9 / COI, client questions, documents, approvals; receipt chase and dunning as their flows land) on each request’s cadence, honouring quiet hours; closes requests whose need is met; escalates unanswered ones. Email + in-app; no GL effect.',
  scope: 'org',
  cron: '*/15 * * * *',
  defaultEnabled: true,
  implemented: true,
  ownerCapability: 'bk.requests_out',
  owner: 'Requests & chase engine (IA M-7, FPB-request-engine-notifications)',
  postsToGl: false,
  timeoutMs: 120_000,
  maxLatenessMinutes: 60,
  maxAttempts: 3,
  run: (ctx) => runRequestsDispatchJob(ctx),
};
