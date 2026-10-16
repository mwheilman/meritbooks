export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { getQboConfigStatus } from '@/lib/integrations/erp/quickbooks/config';
import { buildAuthorizeUrl } from '@/lib/integrations/erp/quickbooks/oauth';
import {
  QBO_STATE_TTL_MS,
  createQboState,
  newNonce,
  safeReturnTo,
} from '@/lib/integrations/erp/quickbooks/state';
import { redirectToApp, setNonceCookie } from '@/lib/integrations/erp/quickbooks/route-helpers';

/**
 * GET /api/integrations/erp/quickbooks/connect?returnTo=/onboarding
 *
 * Starts the per-tenant QuickBooks Online OAuth flow. Used as a BROWSER NAVIGATION
 * (`window.location.href = …`), not a fetch: it 303-redirects to Intuit's consent
 * screen with a signed, org-bound, 10-minute `state`, and sets a matching httpOnly
 * nonce cookie (CSRF binding). Every failure redirects back to `returnTo` with
 * `?qbo=<code>` so the UI can explain it — never a dead JSON page.
 *
 * GATE: settings_system:edit (same as the other connect routes). The org comes from
 * the verified Clerk claim via requirePermission — never from the query string.
 * Degrade-safe: with QBO_* env unset → `?qbo=not_configured` (UI shows the guided
 * "export from QuickBooks" path).
 */
export async function GET(request: Request) {
  const returnTo = safeReturnTo(new URL(request.url).searchParams.get('returnTo'));

  const authRes = await requireAuth();
  if (authRes instanceof NextResponse) return authRes;
  const { userId } = authRes;

  const guard = await requirePermission(userId, 'settings_system', 'edit');
  if (!guard.ok) return redirectToApp(request, returnTo, 'forbidden');

  const cfg = getQboConfigStatus();
  if (!cfg.configured) return redirectToApp(request, returnTo, 'not_configured');

  const nonce = newNonce();
  const state = createQboState({ orgId: guard.orgId, userId, nonce, returnTo }, cfg.config.stateSecret);

  const res = NextResponse.redirect(buildAuthorizeUrl(cfg.config, state), { status: 303 });
  res.headers.set('Cache-Control', 'no-store');
  setNonceCookie(res, nonce, Math.floor(QBO_STATE_TTL_MS / 1000));
  return res;
}
