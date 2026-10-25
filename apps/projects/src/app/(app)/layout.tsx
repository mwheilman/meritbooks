import { redirect } from 'next/navigation';
import { currentUser } from '@clerk/nextjs/server';
import { booksUrl, getScope, type Scope } from '@/lib/scope';
import { requireDb, pm } from '@/lib/pm/db';
import { getModulesFor, getVocabulary } from '@/lib/pm/config';
import { getMe } from '@/lib/pm/people';
import { getAccess } from '@/lib/access';
import { moneyVisFor } from '@/components/money/visibility';
import type { ShellAccess } from '@/components/shell/ShellContext';
import { railNav, type NavCounts } from '@/lib/nav';
import { addDays, todayIso, weekLabel } from '@/lib/time';
import { shortDate } from '@meritbooks/merit-ui';
import { AppFrame } from '@/components/shell/AppFrame';
import { EnableProjectsScreen, NoWorkspaceScreen } from '@/components/shell/GateScreens';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getCompanyExperience } from '@/lib/packs/experience-server';
import { loadInbox } from '@/lib/approvals/server';
import { aiConfigured } from '@/lib/ai/gateway';
import type { AskStatus } from '@/components/shell/CommandPalette';

/**
 * ⌘K Ask: there is no question-answering endpoint yet, so Ask is paused everywhere; the sentence
 * says which part is missing so nobody waits on an answer that will not come.
 */
function askStatus(): AskStatus {
  return aiConfigured()
    ? { available: false, reason: 'AI assist is paused: questions about your numbers arrive with the Ask release. Try a page, a job or a customer.' }
    : { available: false, reason: 'AI assist is paused: the AI service is not switched on for this workspace.' };
}

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
    // Same answer as GET /api/approvals?mine (counts.mine), for the Approvals badge.
    const approvalsMine = await loadInbox(db, { tab: 'mine', companyId: scope.company?.id ?? null, limit: 1 })
      .then((r) => r.counts?.mine ?? 0, () => 0);
    return {
      approvalsMine,
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
  const [access, me, modules, vocab, navCounts, experience] = await Promise.all([
    getAccess(),
    getMe(db, scope.userId),
    getModulesFor(db, scope.companyIds, scope.installs),
    getVocabulary(db, scope.company?.id ?? null, scope.companyIds),
    counts(db, scope),
    // The company in view's industry experience (pack manifest v2): its rail per persona.
    scope.context === 'client' ? getCompanyExperience(db, scope.company?.id ?? null) : Promise.resolve(null),
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
  const companyId = scope.company?.id ?? null;
  const shellAccess: ShellAccess = {
    persona: access.persona,
    group: access.group,
    title: access.title,
    preview: access.preview,
    moneyLevel: access.moneyLevel,
    grants: [...(companyId ? access.byCompany[companyId] ?? new Set<string>() : access.grants)],
  };

  return (
    <AppFrame
      context={scope.context}
      density={access.group === 'management' ? 'report' : 'cockpit'}
      nav={railNav({
        access,
        companyId,
        context: scope.context,
        vocab,
        modules,
        counts: navCounts,
        booksPresent: scope.tenant.booksPresent,
        companyCount: scope.installedCompanies.length,
        packKeys: scope.installs
          .filter((i) => !scope.company || i.location_id === scope.company.id)
          .map((i) => i.pack_key),
        experience: experience?.experience ?? null,
      })}
      orgName={scope.tenant.orgName ?? 'Workspace'}
      companies={scope.tenant.companies.map((c) => ({ id: c.id, name: c.name, shortCode: c.shortCode, installed: installedIds.has(c.id) }))}
      activeCompanyId={scope.company?.id ?? null}
      view={scope.view}
      user={{ name, role: access.preview ? `Previewing ${access.title}` : access.title }}
      week={{ label: weekLabel(today), range: `${shortDate(monday)}–${shortDate(addDays(monday, 6))}` }}
      booksUrl={booksUrl()}
      vocab={vocab}
      readOnly={scope.readOnly}
      access={shellAccess}
      money={moneyVisFor(access, companyId)}
      ask={askStatus()}
    >
      {children}
    </AppFrame>
  );
}
