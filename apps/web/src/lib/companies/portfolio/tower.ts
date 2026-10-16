/**
 * Onboarding Control Tower — one row per company, showing how far each one is from
 * "live on MeritBooks" (FPB principle 9: many companies = one motion).
 *
 * Stages (each implies the ones before it):
 *   created   — the company exists (core.locations)
 *   uploaded  — a trial balance was dropped → a conversion session exists
 *               (public.ai_decisions, feature CONVERSION_MAP, kind ONBOARDING_CONVERSION)
 *   matched   — every source account is matched to a chart-of-accounts account
 *               (no unmapped / unknown targets on the session)
 *   checked   — a person tied out the opening trial balance (session.tiedOut)
 *   live      — the opening entry is posted (gl_entries source_module OPENING_BALANCE,
 *               status POSTED, for this company — or the session links a posted entry)
 *
 * The pure pieces (stage / status / next action) are unit-tested; `loadControlTower`
 * reads real, org-scoped data through the caller's RLS client.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { loadOnboardingOwners } from '@/lib/team/onboarding-ownership';
import { loadEmployeeNames } from '@/lib/portfolio/board';
import type { ControlTowerData, TowerRow, TowerSession, TowerStage } from './types';
import { TOWER_STAGES } from './types';
import {
  coerceStatus,
  deriveStage,
  nextActionFor,
  pickSession,
  stageIndex,
  statusForStage,
  statusToSync,
} from './tower-stage';

// The conversion session discriminators (mirrors lib/onboarding/conversion.ts —
// read-only use; that module is owned by the conversion slice).
const CONVERSION_FEATURE = 'CONVERSION_MAP';
const CONVERSION_KIND = 'ONBOARDING_CONVERSION';

// ── Loader ───────────────────────────────────────────────────────────────────

interface SessionRowRaw {
  id: string;
  status: string;
  location_id: string | null;
  posted_gl_entry_id: string | null;
  created_at: string;
  kind: string | null;
  company_id: string | null;
  as_of: string | null;
  tied_out: boolean | null;
  unmapped: unknown;
  unknown_targets: unknown;
  balance: { balanced?: boolean } | null;
}

function arrLen(v: unknown): number {
  return Array.isArray(v) ? v.length : 0;
}

export async function loadControlTower(
  db: SupabaseClient,
  orgId: string,
  now: Date = new Date(),
): Promise<ControlTowerData> {
  // Companies (with onboarding status — degrade-safe if migration 121 is absent).
  let statusAvailable = true;
  type LocRow = {
    id: string; name: string; short_code: string; created_at: string;
    onboarding_status?: unknown; onboarding_completed_at?: unknown; is_management_company?: unknown;
  };
  let locations: LocRow[] = [];
  const withStatus = await db
    .schema('core').from('locations')
    .select('id, name, short_code, created_at, onboarding_status, onboarding_completed_at')
    .eq('org_id', orgId)
    .eq('is_active', true)
    .order('name')
    .limit(2000);
  if (withStatus.error) {
    statusAvailable = false;
    const base = await db
      .schema('core').from('locations')
      .select('id, name, short_code, created_at')
      .eq('org_id', orgId)
      .eq('is_active', true)
      .order('name')
      .limit(2000);
    if (base.error) throw new Error(`Could not load companies: ${base.error.message}`);
    locations = (base.data ?? []) as LocRow[];
  } else {
    locations = (withStatus.data ?? []) as LocRow[];
  }

  const y = now.getUTCFullYear();
  const m = now.getUTCMonth() + 1;

  const [sessionsRes, openingRes, periodsRes, owners, names] = await Promise.all([
    db.from('ai_decisions')
      .select(
        'id, status, location_id, posted_gl_entry_id, created_at, ' +
          'kind:proposed_output->>kind, company_id:proposed_output->>companyId, as_of:proposed_output->>asOfDate, ' +
          'tied_out:proposed_output->tiedOut, unmapped:proposed_output->unmapped, ' +
          'unknown_targets:proposed_output->unknownTargets, balance:proposed_output->balance',
      )
      .eq('org_id', orgId)
      .eq('feature', CONVERSION_FEATURE)
      .order('created_at', { ascending: false })
      .limit(1000),
    db.from('gl_entries')
      .select('id, location_id, entry_date')
      .eq('org_id', orgId)
      .eq('source_module', 'OPENING_BALANCE')
      .eq('status', 'POSTED')
      .limit(5000),
    db.from('fiscal_periods')
      .select('location_id')
      .eq('org_id', orgId)
      .eq('period_year', y)
      .eq('period_month', m)
      .limit(5000),
    loadOnboardingOwners(db),
    loadEmployeeNames(db),
  ]);
  if (sessionsRes.error) throw new Error(`Could not load conversion sessions: ${sessionsRes.error.message}`);
  if (openingRes.error) throw new Error(`Could not load opening entries: ${openingRes.error.message}`);
  if (periodsRes.error) throw new Error(`Could not load fiscal periods: ${periodsRes.error.message}`);

  // Sessions grouped by company.
  const sessionsByLoc = new Map<string, TowerSession[]>();
  for (const r of (sessionsRes.data ?? []) as unknown as SessionRowRaw[]) {
    if (r.kind !== CONVERSION_KIND) continue;
    const loc = r.location_id ?? r.company_id;
    if (!loc) continue;
    const s: TowerSession = {
      id: r.id,
      status: r.status,
      asOfDate: r.as_of,
      unmappedCount: arrLen(r.unmapped),
      unknownTargetCount: arrLen(r.unknown_targets),
      balanced: r.balance?.balanced === true,
      tiedOut: r.tied_out === true,
      posted: !!r.posted_gl_entry_id,
      postedEntryId: r.posted_gl_entry_id,
      createdAt: r.created_at,
    };
    const list = sessionsByLoc.get(loc) ?? [];
    list.push(s);
    sessionsByLoc.set(loc, list);
  }

  const openingByLoc = new Map<string, { id: string; date: string }>();
  for (const e of (openingRes.data ?? []) as Array<{ id: string; location_id: string; entry_date: string }>) {
    const prev = openingByLoc.get(e.location_id);
    if (!prev || e.entry_date > prev.date) openingByLoc.set(e.location_id, { id: e.id, date: e.entry_date });
  }

  const hasCurrentPeriod = new Set(((periodsRes.data ?? []) as Array<{ location_id: string }>).map((p) => p.location_id));

  const rows: TowerRow[] = locations.map((l) => {
    const sessions = sessionsByLoc.get(l.id) ?? [];
    const session = pickSession(sessions);
    const opening = openingByLoc.get(l.id) ?? null;
    const stage = deriveStage(session, !!opening);
    const storedStatus = coerceStatus(l.onboarding_status);
    const ownerEmployeeId = owners.byLocation.get(l.id) ?? null;
    const base = {
      stage,
      session,
      periodsMissing: !hasCurrentPeriod.has(l.id),
      openingEntryId: opening?.id ?? session?.postedEntryId ?? null,
    };
    return {
      locationId: l.id,
      name: l.name,
      shortCode: l.short_code,
      createdAt: l.created_at,
      ...base,
      stageIndex: stageIndex(stage),
      sessionCount: sessions.length,
      cutoverDate: opening?.date ?? session?.asOfDate ?? null,
      storedStatus,
      derivedStatus: statusForStage(stage),
      ownerEmployeeId,
      ownerName: ownerEmployeeId ? names.get(ownerEmployeeId) ?? 'Unknown' : null,
      nextAction: nextActionFor(base),
    };
  });

  const counts = Object.fromEntries(TOWER_STAGES.map((s) => [s, 0])) as Record<TowerStage, number>;
  for (const r of rows) counts[r.stage]++;

  return {
    rows,
    counts,
    statusAvailable,
    ownershipAvailable: owners.available,
    statusDrift: statusAvailable ? rows.filter((r) => statusToSync(r.storedStatus, r.derivedStatus) !== null).length : 0,
    generatedAt: now.toISOString(),
  };
}
