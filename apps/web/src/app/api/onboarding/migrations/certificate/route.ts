export const dynamic = 'force-dynamic';
export const maxDuration = 300;

import { NextResponse } from 'next/server';
import { apiHandler, apiQueryHandler } from '@/lib/api-handler';
import { certificateAction, projectQuery } from '@/lib/validations/onboarding-migration';
import { migrationErrorResponse } from '@/lib/onboarding/migration/server/guard';
import { withProject } from '@/lib/onboarding/migration/server/route-support';
import { certificateView, goLive, signOff, signProof, voidCertificate } from '@/lib/onboarding/migration/server/certificate';
import { refreshProject } from '@/lib/onboarding/migration/server/projects';
import { requirePermission } from '@/lib/rbac/require-permission';

/**
 * "Prove balances" → "Signed off" → "Live".
 *   GET  ?id=  the five ties (trial balance, A/R, A/P, bank, equity) computed now from the
 *              staged source and the live book at the cutover, the proof gate (every reason in
 *              dollars), the sign-off gate and the certificate.
 *   POST sign_proof (preparer; journal_entries:create) · sign_off (a DIFFERENT reviewer;
 *        journal_entries:post AND close_mgmt:manage — it hard-closes the months through the
 *        cutover via the period service; the DB refuses preparer = approver) · void (close_mgmt:manage,
 *        reason) · go_live (journal_entries:post; needs a signed-off certificate).
 */
export const GET = apiQueryHandler(projectQuery, async (q, ctx) => {
  const pc = await withProject(ctx, q.id, 'view', '/api/onboarding/migrations/certificate');
  if (pc instanceof NextResponse) return pc;
  try {
    return NextResponse.json(await certificateView(pc.supabase, pc.orgId, pc.project, pc.userId));
  } catch (e) {
    return migrationErrorResponse(e, 'Could not compute the ties');
  }
});

export const POST = apiHandler(certificateAction, async (body, ctx) => {
  const route = '/api/onboarding/migrations/certificate';
  const need = body.action === 'sign_proof' ? 'sign_proof' : body.action === 'sign_off' ? 'sign_off' : body.action === 'void' ? 'void' : 'go_live';
  const pc = await withProject(ctx, body.id, need, route);
  if (pc instanceof NextResponse) return pc;
  try {
    let message: string;
    switch (body.action) {
      case 'sign_proof': {
        const c = await signProof(pc.supabase, pc.orgId, pc.project, pc.userId);
        message = `Balance proof signed. Certificate ${c.number} is waiting for the reviewer.`;
        break;
      }
      case 'sign_off': {
        const r = await signOff(pc.supabase, pc.orgId, pc.project, pc.userId, {
          canManageClose: async () => (await requirePermission(pc.userId, 'close_mgmt', 'manage', { route, locationId: pc.project.location_id })).ok,
        });
        message = `Certificate ${r.certificate.number} signed off. ${r.periodsLocked} month${r.periodsLocked === 1 ? '' : 's'} up to the cutover locked.`;
        break;
      }
      case 'void':
        await voidCertificate(pc.supabase, pc.orgId, pc.project, pc.userId, body.reason);
        message = 'Certificate voided. Prove the balances again to issue a new version.';
        break;
      case 'go_live':
        await goLive(pc.supabase, pc.orgId, pc.project, pc.userId);
        message = 'Live — MeritBooks is the book of record for this client.';
        break;
    }
    const fresh = await withProject(ctx, body.id, 'view', route);
    if (!(fresh instanceof NextResponse)) await refreshProject(fresh.supabase, fresh.orgId, fresh.project, { withTies: false });
    return NextResponse.json({ message });
  } catch (e) {
    return migrationErrorResponse(e, 'Could not complete that step');
  }
});
