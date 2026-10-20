/**
 * Everything the /onboarding page needs, read through the RLS client:
 * companies (tenant.ts) + Books facts (core.jobs counts, unadopted jobs), installs
 * (pm.pack_installs), runs (pm.onboarding_runs), and the pack tiles.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { getPack, listPacks, type WorkspacePlan } from '@meritbooks/industry-packs';
import type { Company } from '@/lib/tenant';
import { booksGuess, preselectCompanies } from './preselect';
import { latestRuns, listRuns, runBrief } from './runs';
import type { CompanyBrief, PackTile, RunBrief, TeamMember } from './types';

export interface OnboardingState {
  companies: CompanyBrief[];
  orgRun: RunBrief | null;
  tiles: PackTile[];
  /** a load problem the page should explain (e.g. the pm schema isn't reachable) */
  problem: string | null;
}

export function packTiles(): PackTile[] {
  return listPacks().map((p) => ({ key: p.key, name: p.name, label: p.tile.label, examples: p.tile.examples, tagline: p.tagline }));
}

interface InstallRow { id: string; location_id: string; pack_key: string; pack_version: string; role: string; status: string }

async function jobFacts(db: SupabaseClient, companyIds: string[]): Promise<Map<string, { jobs: number; unadopted: number }>> {
  const out = new Map<string, { jobs: number; unadopted: number }>();
  for (const id of companyIds) out.set(id, { jobs: 0, unadopted: 0 });
  if (companyIds.length === 0) return out;
  const [{ data: jobs }, { data: projects }] = await Promise.all([
    db.schema('core').from('jobs').select('id, location_id').in('location_id', companyIds).limit(10_000),
    db.schema('pm').from('projects').select('job_id').limit(10_000),
  ]);
  const adopted = new Set(((projects ?? []) as { job_id: string }[]).map((p) => p.job_id));
  for (const j of (jobs ?? []) as { id: string; location_id: string }[]) {
    const f = out.get(j.location_id);
    if (!f) continue;
    f.jobs += 1;
    if (!adopted.has(j.id)) f.unadopted += 1;
  }
  return out;
}

export async function loadOnboardingState(db: SupabaseClient, companies: Company[]): Promise<OnboardingState> {
  const ids = companies.map((c) => c.id);
  const [facts, installsRes, runsRes] = await Promise.all([
    jobFacts(db, ids),
    db.schema('pm').from('pack_installs').select('id, location_id, pack_key, pack_version, role, status').eq('status', 'ACTIVE'),
    listRuns(db),
  ]);
  const problem = installsRes.error || runsRes.error
    ? "We couldn't read your Merit Projects setup. If this is a new workspace, the Projects data layer may still be switching on."
    : null;
  const installs = ((installsRes.data ?? []) as InstallRow[]).filter((i) => i.role === 'primary');
  const runs = latestRuns(runsRes.rows);
  const pre = preselectCompanies(companies.map((c) => ({
    id: c.id, name: c.name, industry: c.industry, revRecMethod: c.revRecMethod,
    jobCount: facts.get(c.id)?.jobs ?? 0, isManagementCompany: c.isManagementCompany,
  })));

  const briefs: CompanyBrief[] = companies.map((c) => {
    const f = facts.get(c.id) ?? { jobs: 0, unadopted: 0 };
    const inst = installs.find((i) => i.location_id === c.id);
    const run = runs.get(c.id);
    const p = pre.get(c.id)!;
    return {
      id: c.id,
      name: c.name,
      shortCode: c.shortCode,
      industry: c.industry,
      revRecMethod: c.revRecMethod,
      jobCount: f.jobs,
      unadoptedJobCount: f.unadopted,
      installed: inst ? { packKey: inst.pack_key, version: inst.pack_version, name: getPack(inst.pack_key)?.name ?? inst.pack_key, installId: inst.id } : null,
      run: run ? runBrief(run) : null,
      booksGuess: booksGuess({ name: c.name, industry: c.industry, revRecMethod: c.revRecMethod, jobCount: f.jobs }),
      preselect: { selected: p.selected, reasons: p.reasons },
    };
  });
  const org = runs.get('');
  return { companies: briefs, orgRun: org ? runBrief(org) : null, tiles: packTiles(), problem };
}

/** The installed primary plan for a company (mode=change diff), or null. */
export async function installedPlan(db: SupabaseClient, companyId: string): Promise<WorkspacePlan | null> {
  const { data } = await db.schema('pm').from('pack_installs').select('resolved')
    .eq('location_id', companyId).eq('role', 'primary').eq('status', 'ACTIVE').limit(1).maybeSingle();
  const resolved = (data as { resolved?: unknown } | null)?.resolved;
  return resolved && typeof resolved === 'object' && 'plan_hash' in (resolved as object) ? (resolved as WorkspacePlan) : null;
}

/** Active job types on a company (for imports and adopting Books jobs). */
export async function companyJobTypes(db: SupabaseClient, companyId: string): Promise<{ key: string; label: string; archetype: string }[]> {
  const { data } = await db.schema('pm').from('job_types').select('key, label, archetype, sort')
    .eq('location_id', companyId).eq('is_active', true).order('sort');
  return ((data ?? []) as { key: string; label: string; archetype: string }[]).map((j) => ({ key: j.key, label: j.label, archetype: j.archetype }));
}

export async function teamMembers(db: SupabaseClient): Promise<TeamMember[]> {
  const { data } = await db.schema('core').from('employees').select('id, first_name, last_name, title, email, role, is_active')
    .eq('is_active', true).order('last_name').limit(200);
  return ((data ?? []) as { id: string; first_name: string; last_name: string; title: string | null; email: string | null; role: string | null }[])
    .map((e) => ({ id: e.id, name: `${e.first_name} ${e.last_name}`.trim(), title: e.title, email: e.email, role: e.role }));
}
