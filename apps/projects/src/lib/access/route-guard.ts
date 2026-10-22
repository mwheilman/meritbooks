import 'server-only';
/**
 * Access check for route handlers that don't use route() (the /api/onboarding/* wrapper):
 *   const denied = await denyUnless('projects.settings', 'configure', body.companyId);
 *   if (denied) return denied;
 * Same 403 body as route(): { error, code: 'FORBIDDEN' }.
 */
import { NextResponse } from 'next/server';
import { can } from './can';
import { forbiddenBody } from './guard';
import { getAccess } from './server';
import type { AccessAction, ProjectCapability } from './types';

export async function denyUnless(cap: ProjectCapability, action: AccessAction, companyId?: string | null): Promise<NextResponse | null> {
  const access = await getAccess();
  if (can(access, cap, action) && (!companyId || can(access, cap, action, companyId))) return null;
  return NextResponse.json(forbiddenBody(cap, action), { status: 403 });
}
