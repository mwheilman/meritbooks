export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { createAdminSupabase } from '@/lib/supabase/server';
import { resolveActor } from '@/lib/trust/actor';
import type { ActorType, Tier } from '@/lib/trust/action-log';
import {
  resolveWorkActions,
  resolveTargets,
  computeThroughput,
  buildLeaderboard,
  latencyMs,
  averageLatencyMs,
  medianLatencyMs,
  msToHours,
  safeRate,
  type Targets,
  type ScorecardInput,
  type LeaderboardEntry,
  type WorkActionDef,
} from '@/lib/team-performance/compute';

/**
 * GET /api/team-performance
 * Per-person performance scorecards + team roll-up + a difficulty-weighted,
 * quality-gated leaderboard, derived from core.action_log (the attribution spine)
 * plus targeted live-ledger reads. FPB-team-performance, Wave 1 (zero schema
 * change beyond migration 074).
 *
 * ── Scope / RBAC (FPB Dim 14, privacy boundary) ──
 *   ?scope=self  → auth only; returns ONLY the caller's own card. No peers, no
 *                  leaderboard. A bookkeeper's coaching self-view.
 *   ?scope=team  → requires permission('team','view'); returns every person's
 *                  card + rollup + leaderboard. Manager view. (default)
 *
 * ── Period ── ?days=N (default 30, trailing window; clamped 1..366).
 *
 * ── Attribution (CANON §2) ── who-did-what comes from action_log.actor_user_id,
 * NEVER gl_entries.created_by (null for AI + on the bank-feed/JE paths).
 *
 * ── null-when-no-data (FPB) ── metrics with no supporting rows (e.g.
 * categorized_at is null on all historical bank txns) return null / "n/a", not 0.
 *
 * NEEDS CENTRAL (reported, not invented): a `team_performance` permission would
 * be cleaner than reusing `team:view` for the manager gate; a `core.assignments`
 * ownership table is required before per-person backlog-aging (E4) / capacity
 * (M5) / entity-coverage (M3) can be attributed honestly — those return null here.
 */

const MAX_ROWS = 5000;
const DAY_MS = 86_400_000;
const TIERS: Tier[] = ['auto', 'review', 'escalate'];

const NEEDS_CENTRAL = [
  'A dedicated `team_performance` permission (view_all vs view_self) would be cleaner than reusing `team:view` for the manager gate — reserved-spine permissions.ts change, reported not made.',
  '`core.assignments` (person × entity × workstream ownership) is required before backlog-aging (E4), capacity-vs-load (M5), and entity-coverage (M3) can be attributed to a person — those fields return null today.',
  'Populate migration 074 `bank_transactions.categorized_at` on the PENDING→CATEGORIZED transition (bank-feed approve does not set it yet) to light up C1/C2 cycle-time; and `fiscal_periods.closed_at` for days-to-close (C4).',
  'Comprehensive `action_log` write coverage with a resolved actor_user_id is the meta-dependency (FPB Dim 16) — metrics are only as complete as instrumentation.',
];

interface LogRow {
  actor_type: ActorType;
  actor_user_id: string | null;
  action: string;
  subject_id: string | null;
  tier: string | null;
  created_at: string;
}

interface TxnRow {
  id: string;
  ai_account_id: string | null;
  final_account_id: string | null;
  created_at: string | null;
  categorized_at: string | null;
  approved_at: string | null;
}

interface PersonAccum {
  actions: string[]; // finished-work action strings (for T7)
  allActionDates: string[]; // every logged action (engagement E1)
  lastActive: string | null; // E2
  humanActions: number;
  // Q4 override (bank feed)
  approvedTxns: number;
  overrides: number;
  // cycle time (C1/C2/C5) — arrays of latencies in ms, null where untimed
  uploadToCategorized: Array<number | null>;
  categorizedToApproved: Array<number | null>;
  approvalLatency: Array<number | null>;
  // Q1 rework — gl.post subject ids this person authored
  postSubjectIds: Set<string>;
  posts: number;
}

function newAccum(): PersonAccum {
  return {
    actions: [],
    allActionDates: [],
    lastActive: null,
    humanActions: 0,
    approvedTxns: 0,
    overrides: 0,
    uploadToCategorized: [],
    categorizedToApproved: [],
    approvalLatency: [],
    postSubjectIds: new Set(),
    posts: 0,
  };
}

function asTier(v: string | null): Tier | null {
  return v && (TIERS as string[]).includes(v) ? (v as Tier) : null;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const scope = url.searchParams.get('scope') === 'self' ? 'self' : 'team';
  const daysRaw = Number(url.searchParams.get('days') ?? '30');
  const days = Number.isFinite(daysRaw) ? Math.min(366, Math.max(1, Math.floor(daysRaw))) : 30;

  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  // ── RBAC gate ──────────────────────────────────────────────────────────────
  // Manager (team) view is permission-gated. Self view needs only auth but must
  // resolve the caller's own core.users id so it can filter to their rows.
  let selfUserId: string | null = null;
  if (scope === 'team') {
    const guard = await requirePermission(userId, 'team', 'view');
    if (!guard.ok) return guard.response;
  } else {
    const { coreUserId } = await resolveActor(supabase, userId);
    selfUserId = coreUserId;
    if (!selfUserId) {
      // No resolvable identity → empty self card rather than leaking anything.
      return NextResponse.json({
        scope,
        period: { days, since: new Date(Date.now() - days * DAY_MS).toISOString() },
        people: [],
        team: null,
        leaderboard: null,
        needsCentral: NEEDS_CENTRAL,
      });
    }
  }

  const sinceIso = new Date(Date.now() - days * DAY_MS).toISOString();

  // ── Load tenant performance config (weights + targets); RLS-scoped. ──────────
  const { data: cfg } = await supabase
    .from('performance_config')
    .select('action_weights, targets')
    .eq('org_id', orgId)
    .maybeSingle();
  const catalog = resolveWorkActions((cfg?.action_weights ?? null) as Record<string, number> | null);
  const targets: Targets = resolveTargets((cfg?.targets ?? null) as Partial<Targets> | null);

  // ── Load the action_log window (the attribution spine), RLS-scoped. ──────────
  const { data: logRows, error: logErr } = await supabase
    .schema('core')
    .from('action_log')
    .select('actor_type, actor_user_id, action, subject_id, tier, created_at')
    .eq('org_id', orgId)
    .gte('created_at', sinceIso)
    .order('created_at', { ascending: false })
    .limit(MAX_ROWS);
  if (logErr) return NextResponse.json({ error: logErr.message, code: 'QUERY_ERROR' }, { status: 500 });

  const rows = (logRows ?? []) as LogRow[];

  // Team-level actor split + autonomy (reuse /api/operations semantics).
  const actorSplit: Record<ActorType, number> = { HUMAN: 0, AI: 0, SYSTEM: 0 };
  const aiTiers: Record<Tier, number> = { auto: 0, review: 0, escalate: 0 };

  // Per-person accumulation over HUMAN rows (optionally filtered to self).
  const people = new Map<string, PersonAccum>();
  const bankApproveSubjectIds = new Set<string>();
  const glPostSubjects: Array<{ userId: string; subjectId: string }> = [];

  for (const r of rows) {
    if (r.actor_type === 'HUMAN' || r.actor_type === 'AI' || r.actor_type === 'SYSTEM') {
      actorSplit[r.actor_type] += 1;
    }
    if (r.actor_type === 'AI') {
      const t = asTier(r.tier);
      if (t) aiTiers[t] += 1;
    }
    if (r.actor_type !== 'HUMAN' || !r.actor_user_id) continue;
    if (scope === 'self' && r.actor_user_id !== selfUserId) continue;

    const acc = people.get(r.actor_user_id) ?? newAccum();
    acc.humanActions += 1;
    acc.allActionDates.push(r.created_at);
    if (!acc.lastActive || r.created_at > acc.lastActive) acc.lastActive = r.created_at;

    const def: WorkActionDef | undefined = catalog[r.action];
    if (def) acc.actions.push(r.action);

    if (r.action === 'bankfeed.approve' && r.subject_id) {
      bankApproveSubjectIds.add(r.subject_id);
    }
    if (r.action === 'gl.post' && r.subject_id) {
      acc.posts += 1;
      acc.postSubjectIds.add(r.subject_id);
      glPostSubjects.push({ userId: r.actor_user_id, subjectId: r.subject_id });
    }
    people.set(r.actor_user_id, acc);
  }

  const aiTierTotal = aiTiers.auto + aiTiers.review + aiTiers.escalate;
  const autonomyRate = aiTierTotal > 0 ? aiTiers.auto / aiTierTotal : null;

  // ── Join bank-feed approvals → bank_transactions for Q4 override + C1/C2. ────
  // subject_id on 'bankfeed.approve' is the bank_transactions.id. This is the
  // honest attribution path (approved_by is written null, uuid-unmapped).
  const txnById = new Map<string, TxnRow>();
  if (bankApproveSubjectIds.size > 0) {
    const ids = Array.from(bankApproveSubjectIds).slice(0, MAX_ROWS);
    const { data: txns } = await supabase
      .from('bank_transactions')
      .select('id, ai_account_id, final_account_id, created_at, categorized_at, approved_at')
      .in('id', ids)
      .limit(MAX_ROWS);
    for (const t of (txns ?? []) as TxnRow[]) txnById.set(t.id, t);
  }

  // Re-walk the approve events (a person may approve many txns) to attribute
  // override + cycle-time per person.
  for (const r of rows) {
    if (r.actor_type !== 'HUMAN' || r.action !== 'bankfeed.approve' || !r.actor_user_id || !r.subject_id) continue;
    if (scope === 'self' && r.actor_user_id !== selfUserId) continue;
    const acc = people.get(r.actor_user_id);
    const txn = txnById.get(r.subject_id);
    if (!acc || !txn) continue;
    acc.approvedTxns += 1;
    // Q4: a human overrode the AI's proposed account (both present + differ).
    if (txn.ai_account_id && txn.final_account_id && txn.ai_account_id !== txn.final_account_id) {
      acc.overrides += 1;
    }
    // Cycle time — categorized_at is null on historical rows → null (n/a), not 0.
    acc.uploadToCategorized.push(latencyMs(txn.created_at, txn.categorized_at));
    acc.categorizedToApproved.push(latencyMs(txn.categorized_at, txn.approved_at));
    acc.approvalLatency.push(latencyMs(txn.created_at, txn.approved_at));
  }

  // ── Q1 rework: gl_entries reversing a person's posted entries. ───────────────
  // Attribute via action_log subject_id (the original gl_entry id), NOT created_by.
  const reworkedOriginalIds = new Set<string>();
  const allPostIds = glPostSubjects.map((p) => p.subjectId);
  if (allPostIds.length > 0) {
    const ids = Array.from(new Set(allPostIds)).slice(0, MAX_ROWS);
    const { data: reversals } = await supabase
      .from('gl_entries')
      .select('reversal_of_id')
      .in('reversal_of_id', ids)
      .limit(MAX_ROWS);
    for (const rv of (reversals ?? []) as Array<{ reversal_of_id: string | null }>) {
      if (rv.reversal_of_id) reworkedOriginalIds.add(rv.reversal_of_id);
    }
  }

  // ── Resolve display names (admin, id-scoped to org-derived ids — /operations pattern). ──
  const ids = Array.from(people.keys());
  const nameById = new Map<string, string>();
  if (ids.length > 0) {
    const admin = createAdminSupabase();
    const { data: users } = await admin
      .schema('core')
      .from('users')
      .select('id, first_name, last_name, email')
      .in('id', ids);
    for (const u of (users ?? []) as Array<{
      id: string;
      first_name: string | null;
      last_name: string | null;
      email: string | null;
    }>) {
      const full = `${u.first_name ?? ''} ${u.last_name ?? ''}`.trim();
      nameById.set(u.id, full || u.email || 'Team member');
    }
  }

  // ── Assemble per-person scorecards. ──────────────────────────────────────────
  const scorecardInputs: ScorecardInput[] = [];
  const cards = ids.map((uid) => {
    const acc = people.get(uid)!;
    const throughput = computeThroughput(acc.actions, catalog);
    const overrideRate = safeRate(acc.overrides, acc.approvedTxns);
    let reworked = 0;
    for (const sid of acc.postSubjectIds) if (reworkedOriginalIds.has(sid)) reworked += 1;
    const reworkRate = safeRate(reworked, acc.posts);
    const name = nameById.get(uid) ?? 'Team member';

    scorecardInputs.push({
      userId: uid,
      name,
      throughput,
      overrideRate,
      overrideSample: acc.approvedTxns,
      reworkRate,
      reworkSample: acc.posts,
    });

    const activeDays = new Set(acc.allActionDates.map((d) => d.slice(0, 10))).size;

    return {
      userId: uid,
      name,
      throughput,
      cycleTime: {
        // C1/C2 read n/a until migration 074's categorized_at is populated on the
        // PENDING→CATEGORIZED transition (bank-feed approve does not set it yet).
        uploadToCategorizedHrsAvg: msToHours(averageLatencyMs(acc.uploadToCategorized)),
        categorizedToApprovedHrsAvg: msToHours(averageLatencyMs(acc.categorizedToApproved)),
        approvalLatencyHrsAvg: msToHours(averageLatencyMs(acc.approvalLatency)),
        approvalLatencyHrsMedian: msToHours(medianLatencyMs(acc.approvalLatency)),
      },
      quality: {
        overrideRate, // Q4 (null = n/a)
        overrideSample: acc.approvedTxns,
        reworkRate, // Q1 (null = n/a)
        reworkSample: acc.posts,
        qualityFlag: reworkRate != null && reworkRate > targets.reworkGate,
      },
      autonomy: {
        humanActions: acc.humanActions,
        // Per-person AI-leverage (D3) needs the assignments/queue model — n/a today.
        aiLeverage: null as number | null,
      },
      engagement: {
        activeDays,
        lastActive: acc.lastActive,
      },
      backlog: {
        // E4 per-person backlog aging needs core.assignments (ownership) — n/a today.
        openItems: null as number | null,
        oldestDays: null as number | null,
      },
    };
  });

  // Highest composite first for display.
  cards.sort((a, b) => b.throughput.composite - a.throughput.composite);

  // ── Team roll-up + leaderboard (manager scope only). ─────────────────────────
  let team: unknown = null;
  let leaderboard: { entries: LeaderboardEntry[]; topPerformerUserId: string | null } | null = null;

  if (scope === 'team') {
    const totalActors = actorSplit.HUMAN + actorSplit.AI + actorSplit.SYSTEM;
    const teamComposite = Math.round(cards.reduce((s, c) => s + c.throughput.composite, 0) * 1000) / 1000;

    // Team cycle-time medians across everyone's datapoints.
    const allCat: Array<number | null> = [];
    const allAppr: Array<number | null> = [];
    for (const acc of people.values()) {
      allCat.push(...acc.uploadToCategorized);
      allAppr.push(...acc.approvalLatency);
    }
    // Team rework rate: reworked posts / total posts across the team.
    let teamPosts = 0;
    let teamReworked = 0;
    for (const acc of people.values()) {
      teamPosts += acc.posts;
      for (const sid of acc.postSubjectIds) if (reworkedOriginalIds.has(sid)) teamReworked += 1;
    }

    leaderboard = buildLeaderboard(scorecardInputs, targets);
    team = {
      activePeople: cards.length,
      teamComposite,
      machineHumanSplit: {
        human: actorSplit.HUMAN,
        ai: actorSplit.AI,
        system: actorSplit.SYSTEM,
        aiSharePct: totalActors > 0 ? Math.round((actorSplit.AI / totalActors) * 1000) / 10 : null,
      },
      autonomyRate, // D2 (null when no AI-tiered actions)
      cycleTime: {
        uploadToCategorizedHrsMedian: msToHours(medianLatencyMs(allCat)),
        approvalLatencyHrsMedian: msToHours(medianLatencyMs(allAppr)),
      },
      teamReworkRate: safeRate(teamReworked, teamPosts),
    };
  }

  return NextResponse.json({
    scope,
    period: { days, since: sinceIso },
    people: cards,
    team,
    leaderboard,
    needsCentral: NEEDS_CENTRAL,
  });
}
