export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { apiQueryHandler } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { createAdminSupabase } from '@/lib/supabase/server';
import { checkInboundMx, inboundSetupStatus, readInboundConfig } from '@/lib/email/inbound-config';
import { listAliases, redactForwarding } from '@/lib/email/inbound-aliases';
import { messageStats } from '@/lib/email/inbound-log';
import { inboundOverviewQuery } from '@/lib/validations/inbound-email';

/**
 * GET /api/inbound-email[?location_id=…][&check_mx=1]
 *
 * The email-inbox overview the Bills card, the intake queue, Settings → Companies,
 * onboarding and Settings → Email inboxes render: setup status (Active / Not yet
 * active — never a secret), every company address the caller may see (client scope:
 * the company list is read through the caller's RLS client first), last-7-day counts
 * and — for admins, on request — a DNS check of the MX record.
 *
 * bills:view. `can.manage` = settings_system:edit (edit sender rules / switch off).
 */
export const GET = apiQueryHandler(inboundOverviewQuery, async (q, { userId, supabase }) => {
  const guard = await requirePermission(userId, 'bills', 'view', { route: '/api/inbound-email' });
  if (!guard.ok) return guard.response;
  const orgId = guard.orgId;
  const manage = (await requirePermission(userId, 'settings_system', 'edit', { route: '/api/inbound-email' })).ok;

  // Companies the caller can see (RLS + client scope decide), optionally narrowed to one.
  let locQ = supabase.schema('core').from('locations').select('id').eq('org_id', orgId);
  if (q.location_id) locQ = locQ.eq('id', q.location_id);
  const { data: locs, error: locErr } = await locQ;
  if (locErr) return NextResponse.json({ error: locErr.message, code: 'LOAD_FAILED' }, { status: 500 });
  const locationIds = ((locs ?? []) as Array<{ id: string }>).map((l) => l.id);
  if (q.location_id && locationIds.length === 0) {
    return NextResponse.json({ error: 'Company not found', code: 'NOT_FOUND' }, { status: 404 });
  }

  const cfg = readInboundConfig();
  const status = inboundSetupStatus(cfg);
  const admin = createAdminSupabase();
  const listed = locationIds.length ? await listAliases(admin, orgId, { locationIds, cfg }) : [];
  // The forwarding code / link is for whoever can manage the address only.
  const aliases = manage ? listed : listed.map(redactForwarding);
  const stats = await messageStats(supabase, orgId, q.location_id ?? null, new Date(), { includeNoCompany: manage });
  const mx = manage && q.check_mx === '1' ? await checkInboundMx(cfg) : null;

  return NextResponse.json({
    status: {
      state: status.state,
      provider: status.provider,
      providerLabel: status.providerLabel,
      domain: status.domain,
      domainConfigured: status.domainConfigured,
      credentialConfigured: status.credentialConfigured,
      mxHost: status.mxHost,
      // what is missing is admin information; others just see "not yet active"
      missing: manage ? status.missing : [],
    },
    mx,
    aliases,
    stats,
    can: { manage },
  });
});
