import { NextResponse } from 'next/server';
import { z } from 'zod';
import { apiHandler } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { logHumanAction } from '@/lib/trust/action-log';
import { assertWriteScope } from '@/lib/db/scoped-writer';
import { loadClientScope } from '@/lib/rbac/client-scope';
import { clearCompanySettings, saveReleaseSettings } from '@/lib/reports/governance/releases';
import { governanceError, noOrg } from '@/lib/reports/governance/http';

export const dynamic = 'force-dynamic';

const deadline = z.object({
  key: z.string().trim().min(1).max(60),
  label: z.string().trim().min(1).max(80),
  cadence: z.enum(['monthly', 'quarterly', 'annual']),
  daysAfterPeriodEnd: z.number().int().min(0).max(400),
  recipient: z.string().trim().max(120).optional().nullable(),
});

const body = z.object({
  location_id: z.string().uuid().nullable(),
  /** Company only: drop the override and follow the tenant rule. */
  clear: z.boolean().optional(),
  auto_release_enabled: z.boolean(),
  auto_release_days: z.number().int().min(0).max(120),
  auto_release_min_status: z.enum(['SOFT_CLOSE', 'HARD_CLOSE']),
  deadlines: z.array(deadline).max(12),
});

/**
 * PUT /api/report-governance/settings — the release rule (tenant, or a company override).
 * close_mgmt:manage. The TENANT-WIDE rule (location_id null — incl. auto-release, which
 * releases every company that follows it) additionally needs all-clients scope; a company
 * override needs write scope on that company.
 */
export const PUT = apiHandler(body, async (b, ctx) => {
  if (!ctx.orgId) return noOrg();
  const guard = await requirePermission(ctx.userId, 'close_mgmt', 'manage', { locationId: b.location_id, route: '/api/report-governance/settings' });
  if (!guard.ok) return guard.response;
  if (b.location_id === null) {
    const scope = await loadClientScope({ supabase: ctx.supabase });
    // off = client scoping is not in use for this tenant (everyone sees every client).
    if (scope.mode !== 'off' && !scope.allClients) {
      return NextResponse.json(
        { error: 'Changing the tenant-wide release rule needs access to all clients. Set a company override instead.', code: 'ALL_CLIENTS_REQUIRED' },
        { status: 403 },
      );
    }
  }
  try {
    if (b.location_id) await assertWriteScope(ctx.supabase, ctx.orgId, [b.location_id]);
    if (b.clear && b.location_id) {
      await clearCompanySettings(ctx.supabase, ctx.orgId, b.location_id);
    } else {
      await saveReleaseSettings(ctx.supabase, ctx.orgId, ctx.userId, {
        locationId: b.location_id,
        autoReleaseEnabled: b.auto_release_enabled,
        autoReleaseDays: b.auto_release_days,
        autoReleaseMinStatus: b.auto_release_min_status,
        deadlines: b.deadlines,
      });
    }
    await logHumanAction(ctx.supabase, ctx.userId, ctx.orgId, {
      action: 'reports.release.settings',
      subjectTable: 'report_governance_settings',
      locationId: b.location_id,
      summary: b.clear
        ? 'Company now follows the tenant release rule'
        : `Auto-release ${b.auto_release_enabled ? `on: ${b.auto_release_days} days after month end once ${b.auto_release_min_status === 'HARD_CLOSE' ? 'closed' : 'soft-closed'}` : 'off'}; ${b.deadlines.length} reporting deadline(s)`,
      metadata: { ...b },
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return governanceError(e);
  }
});
