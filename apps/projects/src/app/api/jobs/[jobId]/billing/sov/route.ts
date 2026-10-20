export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { HttpError } from '@/lib/api-errors';
import { route } from '@/lib/api';
import { one, pm, rows } from '@/lib/pm/db';
import { assertMode, loadMoneyJob } from '@/lib/pm/money/job';
import { callRpc, wrote } from '@/lib/pm/money/rpc';
import { PosCents, Rate, Text200, Uuid } from '@/lib/pm/money/schemas';

const LineFields = {
  description: Text200.min(1, 'Describe the line.'),
  scheduledValueCents: PosCents,
  costCodeId: Uuid.nullish(),
  retainagePct: Rate.nullish(),
};

const Body = z.discriminatedUnion('op', [
  z.object({ op: z.literal('create_version'), retainagePct: Rate.nullish(), memo: Text200.nullish(), seed: z.enum(['estimate', 'none']).default('estimate') }),
  z.object({ op: z.literal('add_line'), versionId: Uuid, ...LineFields }),
  z.object({ op: z.literal('update_line'), versionId: Uuid, lineId: Uuid, ...LineFields }),
  z.object({ op: z.literal('remove_line'), versionId: Uuid, lineId: Uuid }),
  z.object({ op: z.literal('set_rate'), versionId: Uuid, retainagePct: Rate.nullish() }),
  z.object({ op: z.literal('activate'), versionId: Uuid, force: z.boolean().default(false) }),
  z.object({ op: z.literal('revise'), versionId: Uuid }),
  z.object({ op: z.literal('delete_version'), versionId: Uuid }),
]);

/**
 * Schedule of values: draft versions are member-editable (column grants; the line guard locks
 * ACTIVE lines), activate_sov_version checks the total against the revised contract,
 * revise_sov copies lines with the same lineage so billed-to-date carries over.
 */
export const POST = route({ body: Body }, async ({ db, params, body }) => {
  const job = await loadMoneyJob(db, params.jobId!);
  assertMode(job, 'sov');
  const p = pm(db);

  if (body.op === 'create_version') {
    const contract = one<{ id: string }>(
      await p.from('contracts').select('id').eq('job_id', job.job_id).eq('status', 'ACTIVE').order('created_at').limit(1).maybeSingle(), 'contract');
    const v = wrote<{ id: string }>(
      await p.from('sov_versions').insert({ job_id: job.job_id, contract_id: contract?.id ?? null, retainage_pct: body.retainagePct ?? null, memo: body.memo ?? null }).select('id').single(),
      'record',
    );
    let seeded = 0;
    if (body.seed === 'estimate') {
      // sell price by cost code from the accepted estimate (the contract side, not the cost budget)
      const est = one<{ id: string }>(await p.from('estimates').select('id').eq('job_id', job.job_id).eq('status', 'ACCEPTED').order('accepted_at', { ascending: false }).limit(1).maybeSingle(), 'accepted estimate');
      if (est) {
        const lines = rows<{ cost_code_id: string | null; description: string; amount_cents: number; sort: number }>(
          await p.from('estimate_lines').select('cost_code_id, description, amount_cents, sort').eq('estimate_id', est.id).order('sort'), 'estimate lines');
        const byCode = new Map<string, { cc: string | null; amt: number; desc: string }>();
        for (const l of lines) {
          const k = l.cost_code_id ?? `line:${l.description}`;
          const cur = byCode.get(k) ?? { cc: l.cost_code_id, amt: 0, desc: l.description };
          cur.amt += l.amount_cents;
          byCode.set(k, cur);
        }
        const ccIds = [...byCode.values()].map((x) => x.cc).filter((x): x is string => !!x);
        const names = ccIds.length
          ? Object.fromEntries(rows<{ id: string; code: string; name: string }>(await p.from('cost_codes').select('id, code, name').in('id', ccIds), 'cost codes').map((c) => [c.id, `${c.code} ${c.name}`]))
          : {};
        const inserts = [...byCode.values()].filter((x) => x.amt > 0).map((x, i) => ({
          sov_version_id: v.id, line_no: i + 1, sort: i, cost_code_id: x.cc, description: (x.cc ? names[x.cc] : null) ?? (x.desc || `Line ${i + 1}`), scheduled_value_cents: x.amt,
        }));
        if (inserts.length) {
          wrote(await p.from('sov_lines').insert(inserts).select('id'), 'record');
          seeded = inserts.length;
        }
      }
    }
    return { versionId: v.id, seeded };
  }

  const v = one<{ id: string; job_id: string; status: string }>(await p.from('sov_versions').select('id, job_id, status').eq('id', body.versionId).maybeSingle(), 'SOV version');
  if (!v || v.job_id !== job.job_id) throw new HttpError(404, 'That schedule of values is not on this job.', 'NOT_FOUND');

  switch (body.op) {
    case 'add_line': {
      const last = one<{ line_no: number; sort: number }>(await p.from('sov_lines').select('line_no, sort').eq('sov_version_id', v.id).order('line_no', { ascending: false }).limit(1).maybeSingle(), 'last line');
      const l = wrote<{ id: string }>(await p.from('sov_lines').insert({
        sov_version_id: v.id, line_no: (last?.line_no ?? 0) + 1, sort: (last?.sort ?? -1) + 1, description: body.description,
        scheduled_value_cents: body.scheduledValueCents, cost_code_id: body.costCodeId ?? null, retainage_pct: body.retainagePct ?? null,
      }).select('id').single(), 'record');
      return { lineId: l.id };
    }
    case 'update_line':
      wrote(await p.from('sov_lines').update({
        description: body.description, scheduled_value_cents: body.scheduledValueCents, cost_code_id: body.costCodeId ?? null, retainage_pct: body.retainagePct ?? null,
      }).eq('id', body.lineId).eq('sov_version_id', v.id).select('id'), 'record');
      return { ok: true };
    case 'remove_line':
      wrote(await p.from('sov_lines').delete().eq('id', body.lineId).eq('sov_version_id', v.id).select('id'), 'record');
      return { ok: true };
    case 'set_rate':
      wrote(await p.from('sov_versions').update({ retainage_pct: body.retainagePct ?? null }).eq('id', v.id).select('id'), 'record');
      return { ok: true };
    case 'activate':
      await callRpc(db, 'activate_sov_version', { p_version: v.id, p_force: body.force }, 'record');
      return { ok: true };
    case 'revise': {
      const id = await callRpc<string>(db, 'revise_sov', { p_version: v.id }, 'record');
      return { versionId: id };
    }
    case 'delete_version':
      if (v.status !== 'DRAFT') throw new HttpError(422, 'Only a draft schedule of values can be deleted.', 'PM_SOV_NOT_DRAFT');
      wrote(await p.from('sov_versions').delete().eq('id', v.id).select('id'), 'record');
      return { ok: true };
  }
});
