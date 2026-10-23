/**
 * `vendors.ai_recheck` — re-read vendor certificates the AI could not read when they
 * arrived (FPB-vendor-compliance-chase §19 A6). While the AI gateway is paused a portal
 * COI lands `received` / `ai_status = unavailable` and a person can key it; once AI is
 * back this job reads the ones still waiting (≤ 14 days old, newest first, a few per run),
 * so the reviewer gets the extracted lines + rule results instead of a blank form.
 * Each document gets at most MAX_AI_ATTEMPTS (3) reads in total (the arrival read
 * included — vendor_document_submissions.ai_attempts, mig 180): a certificate the model
 * cannot read is left to a person instead of being re-sent every hour.
 *
 * Proposes facts only (ai_decisions PROPOSED + the submission's rule results). Never
 * accepts, never touches the GL. Service role, every read/write pinned to ctx.orgId.
 *
 * REGISTRATION (2E / lead — registry.ts is shared spine): add VENDOR_AI_RECHECK_JOB
 * (hourly). Skips cleanly when no AI key is configured.
 */

import { getAnthropicApiKey } from '@/lib/ai/gateway';
import { DOCUMENTS_BUCKET } from '@/lib/documents/store';
import { MAX_AI_ATTEMPTS, runAiCheck, SUBMISSION_COLUMNS, type SubmissionRow } from '@/lib/vendor-compliance/review';
import type { JobContext, JobDefinition, JobResult } from '../types';

const PER_RUN = 10;

export async function runVendorAiRecheckJob(ctx: JobContext): Promise<JobResult> {
  if (!ctx.orgId) return { status: 'skipped', summary: 'This job runs per tenant.' };
  const key = getAnthropicApiKey();
  if (!key) return { status: 'skipped', summary: 'AI is not configured; uploads wait for a person.' };
  const since = new Date(ctx.now.getTime() - 14 * 86_400_000).toISOString();
  const { data, error } = await ctx.admin
    .from('vendor_document_submissions')
    .select(SUBMISSION_COLUMNS)
    .eq('org_id', ctx.orgId)
    .eq('status', 'received')
    .eq('doc_kind', 'COI')
    .in('ai_status', ['unavailable', 'failed', 'pending'])
    .lt('ai_attempts', MAX_AI_ATTEMPTS)
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(PER_RUN);
  if (error) return { status: 'failed', error: error.message };
  const subs = (data ?? []) as SubmissionRow[];
  if (subs.length === 0) return { status: 'skipped', summary: 'Nothing waiting for an AI read.' };

  let read = 0;
  let gaveUp = 0;
  const errors: string[] = [];
  for (const s of subs) {
    if (ctx.signal.aborted) break;
    if (!s.document_id) continue;
    try {
      const { data: doc } = await ctx.admin.from('documents').select('storage_path, mime_type').eq('org_id', ctx.orgId).eq('id', s.document_id).maybeSingle();
      const d = doc as { storage_path: string; mime_type: string | null } | null;
      if (!d) continue;
      const { data: blob, error: dlErr } = await ctx.admin.storage.from(DOCUMENTS_BUCKET).download(d.storage_path);
      if (dlErr || !blob) {
        errors.push(`${s.id}: ${dlErr?.message ?? 'no file'}`);
        continue;
      }
      const base64 = Buffer.from(await blob.arrayBuffer()).toString('base64');
      const res = await runAiCheck(ctx.admin, s, { base64, mediaType: d.mime_type || 'application/pdf' }, { anthropicApiKey: key }, ctx.now);
      if (res.ai_status === 'done') read++;
      else if ((res.ai_attempts ?? 0) >= MAX_AI_ATTEMPTS) {
        gaveUp++;
        await ctx.admin
          .from('vendor_document_submissions')
          .update({ ai_note: `AI tried ${MAX_AI_ATTEMPTS} times and could not read this certificate. Key the coverage lines from the document.`, updated_at: ctx.now.toISOString() })
          .eq('org_id', ctx.orgId)
          .eq('id', s.id);
      }
      if (res.ai_status === 'unavailable') break; // still paused — try next hour
    } catch (e) {
      errors.push(`${s.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return {
    status: errors.length === 0 ? 'ok' : read > 0 ? 'partial' : 'failed',
    itemsProcessed: read,
    counts: { waiting: subs.length, read, gaveUp },
    summary: `${read} of ${subs.length} waiting certificate(s) read by AI.${gaveUp ? ` ${gaveUp} left to a person after ${MAX_AI_ATTEMPTS} tries.` : ''}`,
    error: errors.length ? errors.slice(0, 5).join('; ') : undefined,
  };
}

export const VENDOR_AI_RECHECK_JOB: JobDefinition = {
  key: 'vendors.ai_recheck',
  label: 'Vendor certificate AI re-read',
  description:
    'Reads vendor certificates of insurance that arrived while AI was paused, so the review queue shows the extracted coverage lines and requirement checks. Proposes only; a person accepts. No GL effect.',
  scope: 'org',
  cron: '7 * * * *',
  defaultEnabled: true,
  implemented: true,
  ownerCapability: 'ctl.vendor_compliance',
  owner: 'Vendor compliance (FPB-vendor-compliance-chase §19)',
  postsToGl: false,
  timeoutMs: 180_000,
  maxLatenessMinutes: 120,
  maxAttempts: 2,
  run: (ctx) => runVendorAiRecheckJob(ctx),
};
