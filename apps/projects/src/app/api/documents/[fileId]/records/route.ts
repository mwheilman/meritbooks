export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { route } from '@/lib/api';
import { unwrap } from '@/lib/documents/errors';
import { RETENTION_CLASSES } from '@/lib/documents/types';

const Body = z.discriminatedUnion('op', [
  z.object({ op: z.literal('hold'), reason: z.string().trim().min(3).max(500) }),
  z.object({ op: z.literal('release') }),
  z.object({ op: z.literal('retention'), retentionClass: z.enum(RETENTION_CLASSES), retainUntil: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable() }),
]);

/** POST /api/documents/:fileId/records — legal hold on / off (documents:delete) and retention (documents:edit). */
export const POST = route({
  access: { cap: 'projects.documents', action: 'edit' }, mask: false, body: Body,
  ops: { hold: { cap: 'projects.documents', action: 'delete' }, release: { cap: 'projects.documents', action: 'delete' } },
}, async ({ db, params, body }) => {
  const p = db.schema('pm');
  if (body.op === 'retention') unwrap(await p.rpc('doc_set_retention', { p_file: params.fileId!, p_class: body.retentionClass, p_until: body.retainUntil }));
  else unwrap(await p.rpc('doc_set_legal_hold', { p_file: params.fileId!, p_hold: body.op === 'hold', p_reason: body.op === 'hold' ? body.reason : null }));
  return { ok: true };
});
