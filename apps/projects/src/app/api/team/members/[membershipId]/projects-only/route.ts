import { z } from 'zod';
import { route } from '@/lib/api';
import { HttpError, PmQueryError } from '@/lib/api-errors';

export const dynamic = 'force-dynamic';

const Body = z.object({ on: z.boolean() });

/** pm.set_projects_only refusals, in words the owner can act on. */
function refusal(message: string): string | null {
  if (/own seat/.test(message)) return 'You can’t change your own seat. Ask another owner.';
  if (/owner \/ admin seat/.test(message)) return 'Owners and admins always keep access to Merit Books.';
  if (/every company/.test(message)) return 'This person also works at a company where you can’t manage the team, so only someone who manages all of their companies can change this.';
  if (/requires projects\.team:edit/.test(message)) return 'You need to manage the team to change this.';
  if (/not found/.test(message)) return 'That person is not in this workspace.';
  return null;
}

/**
 * Turn a seat's "Projects only" flag on or off (pm.set_projects_only, 1110). A Projects-only seat
 * sees no Merit Books data and only its own jobs and money per its Projects role. The function is
 * the authority: org-guarded, projects.team:edit at every company of the seat, never an owner /
 * admin seat, never the caller's own seat.
 */
export const POST = route({ access: { cap: 'projects.team', action: 'edit' }, body: Body, mask: false }, async ({ db, params, body }) => {
  const res = await db.schema('pm').rpc('set_projects_only', { p_membership: params.membershipId!, p_on: body.on });
  if (res.error) {
    const words = res.error.code === '42501' ? refusal(res.error.message ?? '') : null;
    if (words) throw new HttpError(403, words, 'FORBIDDEN');
    throw new PmQueryError('set projects only', res.error);
  }
  return { ok: true, projectsOnly: body.on };
});
