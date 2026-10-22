import { redirect } from 'next/navigation';
import { currentUser } from '@clerk/nextjs/server';
import { booksUrl, getScope, type Scope } from '@/lib/scope';
import { requireDb, pm } from '@/lib/pm/db';
import { getModulesFor, getVocabulary } from '@/lib/pm/config';
import { getMe, homeDensityFor, roleLabel } from '@/lib/pm/people';
import { railNav, type NavCounts } from '@/lib/nav';
import { addDays, todayIso, weekLabel } from '@/lib/time';
import { shortDate } from '@meritbooks/merit-ui';
import { AppFrame } from '@/components/shell/AppFrame';
import { EnableProjectsScreen, NoWorkspaceScreen } from '@/components/shell/GateScreens';
import type { SupabaseClient } from '@supabase/supabase-js';

export const dynamic = 'force-dynamic';

/** Cheap rail counts: open jobs, open change orders, overdue tasks — in this scope. */
async function counts(db: SupabaseClient, scope: Scope): Promise<NavCounts> {
  try {
    const today = todayIso();
    const [jobsRes, cosRes, tasksRes] = await Promise.all([
      pm(db).from('projects').select('job_id, location_id, stage_key').in('location_id', scope.companyIds),
      pm(db).from('change_orders').select('job_id').in('stage', ['PCO', 'COR']).limit(1000),
      pm(db).from('tasks').select('job_id').not('status', 'in', '(DONE,CANCELLED)').lt('due_on', today).limit(1000),
    ]);
    const jobs = (jobsRes.data ?? []) as Array<{ job_id: string }>;
    const inScope = new Set(jobs.map((j) => j.job_id));
    const openJobsRes = await pm(db)
      .from('v_project_list')
      .select('job_id', { count: 'exact', head: true })
      .in('location_id', scope.companyIds)
      .not('stage_is_terminal', 'is', true);
    return {
      openJobs: openJobsRes.count ?? undefined,
      toReview: ((cosRes.data ?? []) as Array<{ job_id: string }>).filter((c) => inScope.has(c.job_id)).length,
      overdueTasks: ((tasksRes.data ?? []) as Array<{ job_id: string }>).filter((t) => inScope.has(t.job_id)).length,
    };
  } catch {
    return {};
  }
}

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const r = await getScope();
  if (r.kind === 'onboard') redirect(r.href);
  if (r.kind === 'gate') {
    if (r.state === 'no_session') redirect('/sign-in');
    if (r.state === 'no_org') return <NoWorkspaceScreen />;
    return <EnableProjectsScreen orgName={r.tenant.orgName} booksUrl={booksUrl()} />;
  }
  const scope = r.scope;
  const db = await requireDb();
  const [me, modules, vocab, navCounts] = await Promise.all([
    getMe(db, scope.userId),
    getModulesFor(db, scope.companyIds, scope.installs),
    getVocabulary(db, scope.company?.id ?? null, scope.companyIds),
    counts(db, scope),
  ]);

  let name = [me.firstName, me.lastName].filter(Boolean).join(' ');
  if (!name) {
    const u = await currentUser().catch(() => null);
    name = u?.fullName || u?.primaryEmailAddress?.emailAddress || 'You';
  }

  const today = todayIso();
  const dow = new Date(`${today}T12:00:00Z`).getUTCDay();
  const monday = addDays(today, dow === 0 ? -6 : 1 - dow);
  const installedIds = new Set(scope.installs.map((i) => i.location_id));

  return (
    <AppFrame
      context={scope.context}
      density={homeDensityFor(me.role)}
      nav={railNav({
        context: scope.context,
        vocab,
        modules,
        counts: navCounts,
        booksPresent: scope.tenant.booksPresent,
        companyCount: scope.installedCompanies.length,
        packKeys: scope.installs
          .filter((i) => !scope.company || i.location_id === scope.company.id)
          .map((i) => i.pack_key),
      })}
      orgName={scope.tenant.orgName ?? 'Workspace'}
      companies={scope.tenant.companies.map((c) => ({ id: c.id, name: c.name, shortCode: c.shortCode, installed: installedIds.has(c.id) }))}
      activeCompanyId={scope.company?.id ?? null}
      view={scope.view}
      user={{ name, role: roleLabel(me.role) }}
      week={{ label: weekLabel(today), range: `${shortDate(monday)}–${shortDate(addDays(monday, 6))}` }}
      booksUrl={booksUrl()}
      vocab={vocab}
      readOnly={scope.readOnly}
    >
      {children}
    </AppFrame>
  );
}
