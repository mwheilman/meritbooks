/**
 * POST /api/onboarding/import/commit — create the confirmed import rows as jobs
 *   body: { companyId, rows: ImportRow-like[] (≤ 100 per call; the client batches),
 *           vendor?, aiDecisionId? }
 *   → { results: CommitRowResult[] }  (one per row: created | skipped | error)
 *
 * Each row → pm.create_project(p_location, p_job_type_key, p_name, p_customer_id,
 * p_contract_cents, false, p_ext) — core.jobs + pm.projects atomically, job number minted,
 * contract + JOB_PROGRESS when a contract value is given. Provenance rides in ext under
 * `_`-prefixed keys (validate_ext passes those through): _source, _source_ref, _source_row,
 * _source_status, _external_id. Re-running the same file skips rows whose _source_ref exists.
 * Customers are matched to existing core.customers by name (link, don't copy); an unmatched
 * name is kept as text on core.jobs.customer_name. Start date / site address go on pm.projects.
 */
import { z } from 'zod';
import { approveDecision } from '@/lib/ai/decisions';
import { companyJobTypes } from '@/lib/onboarding/load';
import { normName } from '@/lib/onboarding/import/values';
import { RouteError, dbError, json, requireCompany, withOnboarding } from '@/lib/onboarding/route';
import type { CommitRowResult } from '@/lib/onboarding/types';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const Row = z.object({
  rowNumber: z.number().int().min(1),
  name: z.string().trim().min(1).max(200),
  externalId: z.string().max(80).nullable(),
  customer: z.string().max(200).nullable(),
  jobTypeKey: z.string().regex(/^[a-z][a-z0-9_]{1,47}$/),
  contractCents: z.number().int().nonnegative().max(1e14).nullable(),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  statusRaw: z.string().max(80).nullable(),
  status: z.enum(['bid', 'active', 'on_hold', 'complete', 'cancelled']).nullable(),
  siteAddress: z.string().max(200).nullable(),
  sourceRef: z.string().min(3).max(200),
});

const Body = z.object({
  companyId: z.string().uuid(),
  rows: z.array(Row).min(1).max(100),
  vendor: z.string().max(40).nullable().optional(),
  aiDecisionId: z.string().uuid().nullable().optional(),
});

export async function POST(req: Request) {
  return withOnboarding(req, Body, async (body, ctx) => {
    requireCompany(ctx, body.companyId);
    const types = await companyJobTypes(ctx.db, body.companyId);
    if (types.length === 0) throw new RouteError(409, 'NO_PACK', 'Set up this company first, then bring your jobs in.');
    const typeKeys = new Set(types.map((t) => t.key));

    const pm = ctx.db.schema('pm');
    const [{ data: existing }, { data: customers }] = await Promise.all([
      pm.from('projects').select('job_id, ext').eq('location_id', body.companyId).limit(10_000),
      ctx.db.schema('core').from('customers').select('id, name, display_name').is('deleted_at', null).limit(10_000),
    ]);
    const refs = new Map<string, string>();
    for (const p of (existing ?? []) as { job_id: string; ext: Record<string, unknown> | null }[]) {
      const ref = p.ext?._source_ref;
      if (typeof ref === 'string') refs.set(ref, p.job_id);
    }
    const byName = new Map<string, string>();
    for (const c of (customers ?? []) as { id: string; name: string; display_name: string | null }[]) {
      for (const n of [c.name, c.display_name]) if (n) { const k = normName(n); if (k && !byName.has(k)) byName.set(k, c.id); }
    }

    const results: CommitRowResult[] = [];
    for (const r of body.rows) {
      if (refs.has(r.sourceRef)) {
        results.push({ rowNumber: r.rowNumber, name: r.name, status: 'skipped', jobId: refs.get(r.sourceRef)!, message: 'Already brought in' });
        continue;
      }
      const jobTypeKey = typeKeys.has(r.jobTypeKey) ? r.jobTypeKey : types[0].key;
      const customerId = r.customer ? byName.get(normName(r.customer)) ?? null : null;
      const ext: Record<string, unknown> = {
        _source: 'onboarding_import',
        _source_ref: r.sourceRef,
        _source_row: r.rowNumber,
        ...(body.vendor ? { _source_vendor: body.vendor } : {}),
        ...(r.externalId ? { _external_id: r.externalId } : {}),
        ...(r.statusRaw ? { _source_status: r.statusRaw } : {}),
      };
      const { data: jobId, error } = await pm.rpc('create_project', {
        p_location: body.companyId,
        p_job_type_key: jobTypeKey,
        p_name: r.name,
        p_customer_id: customerId,
        p_contract_cents: r.contractCents && r.contractCents > 0 ? r.contractCents : null,
        p_is_sample: false,
        p_ext: ext,
      });
      if (error || !jobId) {
        const e = dbError(error, 'Creating this job');
        if (e.code === 'RPC_MISSING') throw e;
        results.push({ rowNumber: r.rowNumber, name: r.name, status: 'error', jobId: null, message: e.message });
        continue;
      }
      refs.set(r.sourceRef, jobId as string);
      const notes: string[] = [];
      if (r.startDate || r.siteAddress) {
        const { error: upErr } = await pm.from('projects')
          .update({ ...(r.startDate ? { planned_start: r.startDate } : {}), ...(r.siteAddress ? { site_address_line1: r.siteAddress } : {}) })
          .eq('job_id', jobId as string);
        if (upErr) notes.push('start date or address not saved');
      }
      if (r.customer && !customerId) {
        const { error: cErr } = await ctx.db.schema('pm').rpc('set_job_customer', { p_job: jobId as string, p_customer_id: null, p_customer_name: r.customer });
        notes.push(cErr ? 'customer name not saved' : 'customer not in Books yet; kept the name');
      }
      results.push({ rowNumber: r.rowNumber, name: r.name, status: 'created', jobId: jobId as string, message: notes.length ? notes.join('; ') : null });
    }

    if (body.aiDecisionId && results.some((r) => r.status === 'created')) {
      await approveDecision(ctx.db, { id: body.aiDecisionId, orgId: ctx.tenant.orgId, userId: ctx.userId, note: 'Column mapping confirmed; jobs imported' });
    }
    return json({ results });
  });
}
