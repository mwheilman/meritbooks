export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { route } from '@/lib/api';
import { pm } from '@/lib/pm/db';
import { CommitmentLineSchema, commitmentLineRow } from '@/lib/pm/money/commitment-lines';
import { getJobCommitments } from '@/lib/pm/money/queries';
import { assertModule, loadMoneyJob } from '@/lib/pm/money/job';
import { wrote } from '@/lib/pm/money/rpc';
import { Rate, Text200, Text2000, Uuid } from '@/lib/pm/money/schemas';

const Body = z.object({
  type: z.enum(['PO', 'SUBCONTRACT']),
  vendorId: Uuid.nullish(),
  title: Text200.min(1, 'Name the commitment.'),
  description: Text2000.nullish(),
  /** Fraction (10% = 0.1). Always sent: the vendor default on core.vendors is a percent (0–100). */
  retainagePct: Rate.default(0),
  lines: z.array(CommitmentLineSchema).max(200).default([]),
});

export const GET = route({ access: { cap: 'projects.commitments', action: 'view' }, mask: 'commitment' }, async ({ db, params }) => {
  const job = await loadMoneyJob(db, params.jobId!);
  return getJobCommitments(db, job.job_id);
});

/** A DRAFT purchase order or subcontract with its lines (numbers minted PO-/SC-{short}-{YYYY}-{NNNN}). */
export const POST = route({ access: { cap: 'projects.commitments', action: 'create' }, mask: 'commitment', body: Body }, async ({ db, params, body }) => {
  const job = await loadMoneyJob(db, params.jobId!);
  assertModule(job, 'commitments', 'commitments');
  const c = wrote<{ id: string; number: string }>(
    await pm(db).from('commitments').insert({
      job_id: job.job_id, vendor_id: body.vendorId ?? null, commitment_type: body.type, title: body.title,
      description: body.description ?? null, retainage_pct: body.retainagePct,
    }).select('id, number').single(),
    'commitment',
  );
  if (body.lines.length) {
    const res = await pm(db).from('commitment_lines')
      .insert(body.lines.map((l, i) => ({ ...commitmentLineRow(l), commitment_id: c.id, line_no: i + 1 })))
      .select('id');
    if (res.error) {
      await pm(db).from('commitments').delete().eq('id', c.id);
      wrote(res, 'commitment');
    }
  }
  return { commitmentId: c.id, number: c.number };
});
