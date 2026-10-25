import { route } from '@/lib/api';
import { fsCall } from '@/lib/fieldservice/rpc';
import type { PrejobBrief } from '@/lib/fieldservice/types';

/** Pre-job brief (FS-27): history, equipment, membership, AR flags, gate code, pets, the call's answers. */
export const GET = route({ access: { cap: 'projects.jobs', action: 'view' }, mask: ['billing', 'agreement'] }, async ({ db, params }) => {
  return { brief: await fsCall<PrejobBrief>(db, 'fs_prejob_brief', { p_wo: params.woId! }) };
});
