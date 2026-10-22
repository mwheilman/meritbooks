import { route } from '@/lib/api';
import { own, write } from '@/lib/pm/ops/rpc';

export const DELETE = route({ access: { cap: 'projects.documents', action: 'delete' }, mask: false }, async ({ db, params }) => {
  await own(db, 'field_logs', 'id', { id: params.logId! }, 'That log was not found.');
  await write(db.schema('pm').from('field_logs').delete().eq('id', params.logId!).select('id'), 'delete daily log');
  return { ok: true };
});
