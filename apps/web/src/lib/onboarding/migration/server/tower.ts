/**
 * The Migration Control Tower (spec §6) — every client being converted, grouped by wave
 * (a wave is a cutover date; earliest first; Unscheduled last), worst first inside a wave,
 * with stage, sources, blockers in dollars, the one next step and the people. Reads the
 * caller's RLS client, so a bookkeeper sees only their clients' rows (client scope).
 * Uses each project's STORED stage + blocker summary (kept fresh by every workspace visit
 * and every action); "Refresh all" recomputes them.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { STAGE_DEFINITIONS, stageLabel, type NextAction } from '../stages';
import type { ProjectStage, Stage } from '../types';
import { STAGES } from '../types';
import { daysBetween, wholeDollars } from '../format';
import { PROJECT_COLS, loadClients, loadPeople, type ProjectRow, type WaveRow } from './store';

type DB = SupabaseClient;

export interface TowerRow {
  id: string;
  clientId: string;
  clientName: string;
  clientCode: string;
  stage: ProjectStage;
  stageLabel: string;
  daysInStage: number;
  sources: Array<{ systemId: string; name: string; pulled: boolean; missing: number; path: string }>;
  blockerCents: number;
  blockerPhrase: string;
  next: NextAction | null;
  cutoverDate: string | null;
  targetGoLive: string | null;
  preparer: string | null;
  reviewer: string | null;
  lead: string | null;
  preparerUserId: string | null;
  reviewerUserId: string | null;
  certificate: { number: string; status: string } | null;
  late: boolean;
  liveAt: string | null;
}

export interface TowerWave {
  id: string | null;
  name: string;
  cutoverDate: string | null;
  purpose: string | null;
  rows: TowerRow[];
  blockerCents: number;
}

export interface TowerData {
  today: string;
  stageCounts: Record<Stage | 'all', number>;
  waves: TowerWave[];
  totals: { clients: number; live: number; blockerCents: number; blockerText: string; overSla: number };
  notStarted: Array<{ id: string; name: string; shortCode: string }>;
  people: Array<{ userId: string; name: string; role: string | null }>;
  openWaves: Array<{ id: string; name: string; cutoverDate: string }>;
}

/** Days in stage after which a row is "late" (spec: 3 business days default ≈ 5 calendar days). */
export const STAGE_SLA_DAYS = 5;

const SEVERITY_ORDER = (r: TowerRow) => (r.stage === 'live' ? 9 : r.stage === 'paused' ? 8 : 0);

export async function loadTower(db: DB, orgId: string, today: string): Promise<TowerData> {
  const [{ data: projects, error }, { data: waves }, clients, people] = await Promise.all([
    db.from('migration_projects').select(PROJECT_COLS).eq('org_id', orgId).is('archived_at', null).limit(2000),
    db.from('migration_waves').select('id, org_id, name, cutover_date, purpose, default_history_depth, target_go_live, status').eq('org_id', orgId).limit(500),
    loadClients(db, orgId),
    loadPeople(db, orgId),
  ]);
  if (error) throw new Error(`Could not load the Tower: ${error.message}`);
  const proj = (projects ?? []) as unknown as ProjectRow[];
  const clientById = new Map(clients.map((c) => [c.id, c]));
  const nameOf = new Map(people.map((p) => [p.userId, p.name]));
  const waveRows = (waves ?? []) as unknown as WaveRow[];

  const rows: TowerRow[] = proj
    .filter((p) => clientById.has(p.location_id))
    .map((p) => {
      const c = clientById.get(p.location_id)!;
      const bs = (p.blocker_summary ?? {}) as Record<string, unknown>;
      const days = Math.max(0, daysBetween(p.stage_changed_at.slice(0, 10), today));
      const sources = Array.isArray(bs.sources) ? (bs.sources as TowerRow['sources']) : [];
      return {
        id: p.id,
        clientId: c.id,
        clientName: c.name,
        clientCode: c.shortCode,
        stage: p.stage,
        stageLabel: stageLabel(p.stage),
        daysInStage: days,
        sources,
        blockerCents: Number(bs.totalCents ?? 0),
        blockerPhrase: typeof bs.phrase === 'string' ? bs.phrase : 'Not checked yet',
        next: (bs.next as NextAction | undefined) ?? null,
        cutoverDate: p.cutover_date,
        targetGoLive: p.target_go_live,
        preparer: p.preparer_user_id ? nameOf.get(p.preparer_user_id) ?? 'Former member' : null,
        reviewer: p.reviewer_user_id ? nameOf.get(p.reviewer_user_id) ?? 'Former member' : null,
        lead: p.lead_user_id ? nameOf.get(p.lead_user_id) ?? null : null,
        preparerUserId: p.preparer_user_id,
        reviewerUserId: p.reviewer_user_id,
        certificate: (bs.certificate as TowerRow['certificate']) ?? null,
        late: p.stage !== 'live' && days > STAGE_SLA_DAYS,
        liveAt: p.live_at,
      };
    });

  // Group by wave: cutover order, Unscheduled last; inside, worst first (dollars, then earliest stage), live last.
  const groups = new Map<string, TowerWave>();
  for (const w of waveRows.filter((x) => x.status === 'open' || rows.some((r) => proj.find((p) => p.id === r.id)?.wave_id === x.id))) {
    groups.set(w.id, { id: w.id, name: w.name, cutoverDate: w.cutover_date, purpose: w.purpose, rows: [], blockerCents: 0 });
  }
  const unscheduled: TowerWave = { id: null, name: 'Unscheduled', cutoverDate: null, purpose: 'No cutover date yet — usually because the systems aren’t named.', rows: [], blockerCents: 0 };
  for (const r of rows) {
    const wid = proj.find((p) => p.id === r.id)?.wave_id ?? null;
    const g = (wid && groups.get(wid)) || unscheduled;
    g.rows.push(r);
  }
  const stageIdx = (s: ProjectStage) => (STAGES as readonly string[]).indexOf(s);
  const sortRows = (xs: TowerRow[]) => xs.sort((a, b) => SEVERITY_ORDER(a) - SEVERITY_ORDER(b) || b.blockerCents - a.blockerCents || stageIdx(a.stage) - stageIdx(b.stage) || a.clientName.localeCompare(b.clientName));
  const waveList = [...groups.values()].sort((a, b) => (a.cutoverDate ?? '').localeCompare(b.cutoverDate ?? ''));
  if (unscheduled.rows.length > 0) waveList.push(unscheduled);
  for (const w of waveList) {
    sortRows(w.rows);
    w.blockerCents = w.rows.reduce((t, r) => t + r.blockerCents, 0);
  }

  const stageCounts = { all: rows.length } as Record<Stage | 'all', number>;
  for (const d of STAGE_DEFINITIONS) stageCounts[d.stage] = rows.filter((r) => r.stage === d.stage).length;
  const inMigration = new Set(proj.map((p) => p.location_id));
  const blockerCents = rows.reduce((t, r) => t + r.blockerCents, 0);
  return {
    today,
    stageCounts,
    waves: waveList.filter((w) => w.rows.length > 0 || w.id !== null),
    totals: { clients: rows.length, live: rows.filter((r) => r.stage === 'live').length, blockerCents, blockerText: wholeDollars(blockerCents), overSla: rows.filter((r) => r.late).length },
    notStarted: clients.filter((c) => !inMigration.has(c.id)).map((c) => ({ id: c.id, name: c.name, shortCode: c.shortCode })),
    people,
    openWaves: waveRows.filter((w) => w.status === 'open').sort((a, b) => a.cutover_date.localeCompare(b.cutover_date)).map((w) => ({ id: w.id, name: w.name, cutoverDate: w.cutover_date })),
  };
}
