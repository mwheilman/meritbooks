export const dynamic = 'force-dynamic';
export const maxDuration = 300;

import { NextResponse } from 'next/server';
import { apiHandler, apiQueryHandler } from '@/lib/api-handler';
import { mappingAction, projectQuery } from '@/lib/validations/onboarding-migration';
import { guardMigration, migrationErrorResponse, noOrg } from '@/lib/onboarding/migration/server/guard';
import { withProject } from '@/lib/onboarding/migration/server/route-support';
import { bandTotals, decideMapping, loadMappings, loadTargets, runMapping, settleRule } from '@/lib/onboarding/migration/server/mapping';
import { refreshProject } from '@/lib/onboarding/migration/server/projects';
import { userRateLimited } from '@/lib/security/user-limits';

/**
 * "Match accounts".
 *   GET  ?id=  this client's matches (largest balance first), band totals, the MeritBooks
 *              chart, and the firm mapping set in use.
 *   POST run (use_ai optional) · accept · accept_ready · set · request_account · reopen
 *        (journal_entries:create + client scope) · settle_rule (chart_of_accounts:approve).
 */
export const GET = apiQueryHandler(projectQuery, async (q, ctx) => {
  const pc = await withProject(ctx, q.id, 'view', '/api/onboarding/migrations/mapping');
  if (pc instanceof NextResponse) return pc;
  try {
    const [rows, targets] = await Promise.all([loadMappings(pc.supabase, pc.project.id), loadTargets(pc.supabase, pc.orgId)]);
    let set: { id: string; name: string } | null = null;
    if (pc.project.mapping_set_id) {
      const { data } = await pc.supabase.from('mapping_sets').select('id, name').eq('id', pc.project.mapping_set_id).maybeSingle();
      set = (data as { id: string; name: string } | null) ?? null;
    }
    const totals = bandTotals(rows.filter((r) => r.status !== 'accepted').map((r) => ({ band: r.band, balanceCents: r.balance_cents })));
    const accepted = rows.filter((r) => r.status === 'accepted');
    return NextResponse.json({
      rows,
      targets,
      set,
      totals,
      accepted: { count: accepted.length, cents: accepted.reduce((t, r) => t + Math.abs(r.balance_cents), 0) },
      aiConfigured: !!process.env.ANTHROPIC_API_KEY,
    });
  } catch (e) {
    return migrationErrorResponse(e, 'Could not load the matches');
  }
});

export const POST = apiHandler(mappingAction, async (body, ctx) => {
  const route = '/api/onboarding/migrations/mapping';
  if (body.action === 'settle_rule') {
    const g = await guardMigration(ctx.userId, 'settle', route);
    if (!g.ok) return g.response;
    if (!ctx.orgId) return noOrg();
    try {
      await settleRule(ctx.supabase, ctx.orgId, ctx.userId, body.rule_id, body.target_account_id);
      return NextResponse.json({ message: 'Rule settled for every client.' });
    } catch (e) {
      return migrationErrorResponse(e, 'Could not settle the rule');
    }
  }
  const pc = await withProject(ctx, body.id, 'work', route);
  if (pc instanceof NextResponse) return pc;
  // Per-user throttle on the AI-assisted run (a gateway call per press; the tenant budget is the hard cap).
  if (body.action === 'run' && body.use_ai) {
    const limited = userRateLimited('mappingAi', pc.userId);
    if (limited) return limited;
  }
  try {
    let message: string;
    let extra: Record<string, unknown> = {};
    if (body.action === 'run') {
      const r = await runMapping(pc.supabase, pc.orgId, pc.project, pc.userId, { useAi: !!body.use_ai });
      message = `Proposed matches for ${r.proposed} accounts.${r.aiError ? ' AI paused: rules and memory only.' : ''}`;
      extra = r;
    } else {
      const d =
        body.action === 'accept' ? { kind: 'accept' as const, keys: body.keys }
        : body.action === 'accept_ready' ? { kind: 'accept_ready' as const }
        : body.action === 'set' ? { kind: 'set' as const, key: body.key, targetAccountId: body.target_account_id, reason: body.reason ?? null }
        : body.action === 'request_account' ? { kind: 'request_account' as const, key: body.key, note: body.note ?? null }
        : { kind: 'reopen' as const, key: body.key };
      const r = await decideMapping(pc.supabase, pc.orgId, pc.project, pc.userId, d);
      message = r.message;
    }
    await refreshProject(pc.supabase, pc.orgId, pc.project, { withTies: false });
    return NextResponse.json({ message, ...extra });
  } catch (e) {
    return migrationErrorResponse(e, 'Could not save the match');
  }
});
