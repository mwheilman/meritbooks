/**
 * documents.classify_retry — every 15 min, per tenant (FPB-document-intelligence §7.3, §7.7).
 *
 *   1. Re-reads documents whose AI classification / extraction was deferred because AI was
 *      unavailable, over budget or failed (document_intelligence.next_retry_at due, under
 *      MAX_AI_ATTEMPTS), and routes them to their module proposals once AI answers.
 *   2. Sweeps up to 10 stored documents that were never analyzed (the backfill).
 *
 * Proposals only — never posts, never creates a module record. TENANCY: service role with
 * every read and write pinned to ctx.orgId (like the receipts chase and the event drains).
 *
 * REGISTRATION (lead owns lib/scheduler/registry.ts): add DOCUMENTS_CLASSIFY_RETRY_JOB to
 * the registry list.
 */

import { intelDeps } from '@/lib/documents/intelligence/server';
import { retryDue } from '@/lib/documents/intelligence/service';
import type { JobContext, JobDefinition, JobResult } from '../types';

export async function runDocumentsClassifyRetryJob(ctx: JobContext): Promise<JobResult> {
  if (!ctx.orgId) return { status: 'skipped', summary: 'This job runs per tenant.' };
  let r;
  try {
    r = await retryDue(intelDeps({ admin: ctx.admin, now: () => ctx.now }), { orgId: ctx.orgId, signal: ctx.signal });
  } catch (e) {
    return { status: 'failed', error: e instanceof Error ? e.message : String(e) };
  }
  const worked = r.retried + r.analyzed;
  const status: JobResult['status'] = r.errors.length === 0 ? (worked === 0 ? 'skipped' : 'ok') : worked > 0 ? 'partial' : 'failed';
  return {
    status,
    itemsProcessed: worked,
    counts: {
      retried: r.retried,
      newly_analyzed: r.analyzed,
      proposals: r.proposals,
      needs_review: r.needsReview,
      duplicates: r.duplicates,
      links_backfilled: r.linksCreated,
      remaining: r.remaining,
    },
    summary:
      worked === 0
        ? 'No documents waiting to be read.'
        : `${r.retried} document(s) re-read, ${r.analyzed} newly analyzed; ${r.proposals} proposal(s) ready, ${r.needsReview} need a person.`,
    error: r.errors.length ? r.errors.slice(0, 10).join('; ') : undefined,
  };
}

export const DOCUMENTS_CLASSIFY_RETRY_JOB: JobDefinition = {
  key: 'documents.classify_retry',
  label: 'Document intelligence retry',
  description:
    'Re-reads documents whose AI read was deferred (AI paused, over budget, or a failed read) and routes them to Leases, Debt, Insurance, Bills and the other modules as proposals for review; also analyzes stored documents that were never read. No GL effect.',
  scope: 'org',
  cron: '*/15 * * * *',
  defaultEnabled: true,
  implemented: true,
  ownerCapability: 'audit_trail',
  owner: 'Document intelligence (FPB-document-intelligence)',
  postsToGl: false,
  // MUST stay well under the scheduler tick budget (dispatch.ts TICK_BUDGET_MS = 240 s): a unit
  // only starts while `budget left ≥ timeoutMs`, so at 240 s this job was deferred on EVERY tick
  // and never ran — stored documents stayed "Not analyzed". 150 s leaves room for the tick's
  // own reads and the units ahead of it; the sweep stops early on ctx.signal anyway.
  timeoutMs: 150_000,
  maxLatenessMinutes: 60,
  maxAttempts: 3,
  run: (ctx) => runDocumentsClassifyRetryJob(ctx),
};
