export const dynamic = 'force-dynamic';

import { route } from '@/lib/api';
import { TalkSignIn } from '@/lib/commercial/screen-schemas';
import { cmError, cmWrote } from '@/lib/commercial/server';

/** GET /api/commercial/safety/talks/:id — the crew sign-in sheet for a toolbox talk. */
export const GET = route({ access: { cap: 'projects.jobs', action: 'view' }, mask: false }, async ({ db, params }) => {
  const r = await db.schema('pm').from('cm_toolbox_attendance').select('id, worker_name, company, method, signed_at').eq('talk_id', params.talkId!).order('signed_at');
  if (r.error) throw cmError(r.error);
  return { attendance: r.data ?? [] };
});

/** POST /api/commercial/safety/talks/:id — sign one more worker in. */
export const POST = route({ access: { cap: 'projects.documents', action: 'create' }, mask: false, body: TalkSignIn }, async ({ db, body, params }) => {
  return cmWrote<{ id: string }>(await db.schema('pm').from('cm_toolbox_attendance').insert({ talk_id: params.talkId!, worker_name: body.name, company: body.company, method: body.method }).select('id').single());
});
