export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { logHumanAction } from '@/lib/trust/action-log';
import { QboClient } from '@/lib/integrations/erp/quickbooks/client';
import { parseCompanyInfo } from '@/lib/integrations/erp/quickbooks/company-info';
import { getQboConfigStatus } from '@/lib/integrations/erp/quickbooks/config';
import { saveQboConnection } from '@/lib/integrations/erp/quickbooks/connection-store';
import { QboAuthRevokedError, exchangeCode, revokeToken } from '@/lib/integrations/erp/quickbooks/oauth';
import { QBO_NONCE_COOKIE, verifyQboState } from '@/lib/integrations/erp/quickbooks/state';
import {
  clearNonceCookie,
  readCookie,
  redirectToApp,
  type QboReturnCode,
} from '@/lib/integrations/erp/quickbooks/route-helpers';

/**
 * GET /api/integrations/erp/quickbooks/callback?code=…&state=…&realmId=…
 *
 * Intuit redirects here after consent. Order of checks (all fail closed):
 *   1. App configured.
 *   2. `state` signature + expiry + httpOnly nonce cookie match (CSRF / replay).
 *   3. The signed-in user and their resolved org EQUAL the state's user/org, and the
 *      user still holds settings_system:edit — tokens can only land on the org that
 *      started the flow.
 *   4. Exchange the code; read CompanyInfo for the label (best-effort).
 *   5. Store tokens ENCRYPTED in Vault; mark core.erp_connections connected with
 *      external_account_label = company name. No secret is ever on the row.
 * Always ends in a redirect back to the app with `?qbo=<code>`.
 */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const done = (returnTo: string | null, code: QboReturnCode, reason?: string) => {
    const res = redirectToApp(request, returnTo, code, reason);
    clearNonceCookie(res);
    return res;
  };

  const cfg = getQboConfigStatus();
  if (!cfg.configured) return done(null, 'not_configured');
  const config = cfg.config;

  // 2. State + browser binding.
  const check = verifyQboState(params.get('state'), config.stateSecret, {
    cookieNonce: readCookie(request, QBO_NONCE_COOKIE),
  });
  if (!check.ok) {
    return done(null, check.reason === 'expired' ? 'expired' : 'error', 'The QuickBooks sign-in link was invalid or expired. Please try connecting again.');
  }
  const { payload } = check;

  // User clicked "Cancel" / denied on Intuit's screen.
  if (params.get('error')) return done(payload.returnTo, 'cancelled');

  // 3. Identity binding.
  const authRes = await requireAuth();
  if (authRes instanceof NextResponse) return done(payload.returnTo, 'forbidden');
  if (authRes.userId !== payload.userId) return done(payload.returnTo, 'forbidden');
  const guard = await requirePermission(authRes.userId, 'settings_system', 'edit');
  if (!guard.ok || guard.orgId !== payload.orgId) return done(payload.returnTo, 'forbidden');

  const code = params.get('code');
  const realmId = params.get('realmId');
  if (!code || !realmId || !/^\d{1,32}$/.test(realmId)) {
    return done(payload.returnTo, 'error', 'QuickBooks didn’t send back a company. Please try again.');
  }

  // 4. Exchange the code.
  let tokens;
  try {
    tokens = await exchangeCode(config, code, realmId);
  } catch (err) {
    const msg =
      err instanceof QboAuthRevokedError
        ? 'That QuickBooks sign-in already expired. Please try connecting again.'
        : err instanceof Error
          ? err.message
          : 'QuickBooks sign-in failed.';
    return done(payload.returnTo, 'error', msg);
  }

  // Company name for the label (best-effort — a failure here doesn't block connect).
  let companyName: string | null = null;
  try {
    const client = new QboClient({
      environment: config.environment,
      tokens: { getAccessToken: async () => ({ accessToken: tokens.accessToken, realmId }) },
      deadlineMs: 15_000,
    });
    companyName = parseCompanyInfo(await client.companyInfo()).companyName;
  } catch {
    companyName = null;
  }

  // 5. Persist (Vault + row).
  const { createAdminSupabase } = await import('@/lib/supabase/server');
  const admin = createAdminSupabase();
  try {
    await saveQboConnection(admin, {
      orgId: payload.orgId,
      tokens,
      companyName,
      userId: authRes.userId,
      environment: config.environment,
    });
  } catch {
    // We couldn't keep the tokens — revoke so no orphan grant lives at Intuit.
    await revokeToken(config, tokens.refreshToken);
    return done(payload.returnTo, 'error', 'We couldn’t save the QuickBooks connection. Please try again.');
  }

  await logHumanAction(admin, authRes.userId, payload.orgId, {
    action: 'integration.quickbooks.connect',
    subjectTable: 'core.erp_connections',
    summary: `Connected QuickBooks Online${companyName ? ` (${companyName})` : ''}`,
    metadata: { realmId, environment: config.environment },
  }).catch(() => undefined);

  return done(payload.returnTo, 'connected');
}
