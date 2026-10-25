import type { Metadata } from 'next';
import { ButtonLink, InlineNotice, KV, Page, PageHead, Status, Switch, Tag, WidgetState, count } from '@meritbooks/merit-ui';
import { BILLING_MODE_LABELS, DEFAULT_VOCAB, MODULES, MODULE_LABELS, PROGRESS_BASIS_LABELS, type BillingMode, type VocabKey } from '@/lib/packs';
import { booksUrl, pageScope } from '@/lib/scope';
import { requireDb } from '@/lib/pm/db';
import { getInstalledPack, getModules, getVocabulary } from '@/lib/pm/config';
import { listJobTypes, listStageMachines } from '@/lib/pm/projects';
import { listCostCodes } from '@/lib/pm/budget';
import { guardsSentence } from '@/lib/pm/guards';
import { CORE_STATUS_WORDS, stageStatus } from '@/lib/pm/stage';
import { PageLine } from '@/components/common/PageLine';
import { SettingsIndex, type AreaLink } from '@/components/settings/SettingsIndex';
import { CostCodesEditor } from '@/components/settings/CostCodesEditor';
import { LaborRatesEditor } from '@/components/settings/LaborRatesEditor';
import { getLaborSettings, listEmployeeCards, listLaborRates } from '@/lib/pm/labor/queries';
import { listEmployees } from '@/lib/pm/ops/field-queries';
import { personName } from '@/lib/pm/ops/labels';
import { stamp } from '@/lib/time';
import { guardPage } from '@/components/shell/page-guard';
import { holds } from '@/lib/nav';
import { getRealAccess, canPreview } from '@/lib/access';
import { PERSONAS } from '@/lib/access/types';
import { PERSONA_LABEL } from '@/lib/access/templates';
import { TeamArea } from '@/components/settings/TeamArea';
import { loadTeamDirectory, rolesAt } from '@/components/settings/team-data';
import { getCompanyExperience } from '@/lib/packs/experience-server';
import { roleTitleFor } from '@/lib/packs/experience';

export const metadata: Metadata = { title: 'Settings' };

const AREA_KEYS = ['industry', 'job-types', 'stages', 'modules', 'vocabulary', 'cost-codes', 'labor', 'team', 'onboarding'] as const;
type AreaKey = (typeof AREA_KEYS)[number];

export default async function SettingsPage({ searchParams }: { searchParams: { company?: string; area?: string } }) {
  const scope = await pageScope();
  if (!scope) return null;
  const { access } = await guardPage('/settings');
  const db = await requireDb();
  const installed = scope.installedCompanies;
  const company = installed.find((c) => c.id === searchParams.company) ?? (scope.company && installed.find((c) => c.id === scope.company!.id)) ?? installed[0]!;
  const seesRates = holds(access, 'projects.labor_rates:view', company.id);
  const configures = holds(access, 'projects.settings:configure', company.id);
  const requested: AreaKey = (AREA_KEYS as readonly string[]).includes(searchParams.area ?? '') ? (searchParams.area as AreaKey) : 'industry';
  // Pay rates are labor_rates money: the area is absent without the grant.
  const area: AreaKey = requested === 'labor' && !seesRates ? 'industry' : requested;
  const [pack, jobTypes, machines, modules, vocab, codes, rates] = await Promise.all([
    getInstalledPack(db, company.id),
    listJobTypes(db, [company.id]),
    listStageMachines(db, company.id),
    getModules(db, company.id),
    getVocabulary(db, company.id),
    listCostCodes(db, company.id, { includeInactive: true }),
    seesRates ? listLaborRates(db, company.id).catch(() => []) : Promise.resolve([]),
  ]);
  const [team, real, exp] = area === 'team'
    ? await Promise.all([loadTeamDirectory(db, scope.userId), getRealAccess(), getCompanyExperience(db, company.id)])
    : [null, null, null];
  // Industry titles (pack roles slot) wherever a Projects role shows; a custom tenant role keeps its own name.
  const titleOf = (r: { persona: (typeof PERSONAS)[number] | null; title: string }) => (r.persona ? roleTitleFor(exp?.experience, r.persona) ?? r.title : r.title);
  const labor = area === 'labor'
    ? await Promise.all([getLaborSettings(db, company.id), listEmployeeCards(db, company.id), listEmployees(db)])
    : null;
  const changeHref = `/onboarding?company=${company.id}&mode=change`;
  const href = (k: AreaKey) => `/settings?company=${company.id}&area=${k}`;
  const renamed = (Object.keys(DEFAULT_VOCAB) as VocabKey[]).filter((k) => vocab[k] !== DEFAULT_VOCAB[k]);
  const uninstalled = scope.tenant.companies.filter((c) => !installed.some((i) => i.id === c.id));

  const companyAreas: AreaLink[] = [
    { key: 'industry', name: 'Industry setup', desc: 'The industry pack this company runs on', status: pack ? `${pack.name} ${pack.pack_version}` : 'Not set up', attn: !pack, href: href('industry') },
    { key: 'job-types', name: 'Job types', desc: 'Kinds of work, billing and how progress is measured', status: `${count(jobTypes.length)} types`, href: href('job-types') },
    { key: 'stages', name: 'Stages', desc: 'Each job type’s stages and the checks between them', status: `${count(machines.reduce((s, m) => s + m.stages.length, 0))} stages`, href: href('stages') },
    { key: 'modules', name: 'Modules', desc: 'Which parts of Merit Projects this company uses', status: `${count(modules.length)} on`, href: href('modules') },
    { key: 'vocabulary', name: 'Vocabulary', desc: 'What this company calls jobs, customers and the rest', status: renamed.length ? `${count(renamed.length)} renamed` : 'Standard terms', href: href('vocabulary') },
    { key: 'cost-codes', name: 'Cost codes', desc: 'The library budgets and costs are coded to', status: `${count(codes.filter((c) => c.is_active).length)} active`, href: href('cost-codes') },
    ...(seesRates
      ? [{ key: 'labor', name: 'Labor rates', desc: 'Pay, burden and overhead: job cost versus estimating rates', status: rates.length ? `${count(rates.filter((r) => r.is_active).length)} rate cards` : 'Not set up', attn: rates.length === 0, href: href('labor') }]
      : []),
  ];
  const workspaceAreas: AreaLink[] = [
    { key: 'team', name: 'Team and roles', desc: 'Who uses Merit Projects here, their role, and Preview as', status: team ? `${count(team.members.filter((m) => rolesAt(m, company.id).length).length)} people` : 'People and roles', href: href('team') },
    { key: 'onboarding', name: 'Company setup', desc: 'Set up the companies that do not run on Merit Projects yet', status: uninstalled.length ? `${count(uninstalled.length)} not set up` : 'All set up', attn: uninstalled.length > 0, href: href('onboarding') },
    // Screens of their own (Wave A approvals 1113, Wave B imports 1121)
    { key: 'approval-rules', name: 'Approval rules', desc: 'Who approves what, by amount, and the exceptions log', href: '/approvals/policies' },
    ...(configures ? [{ key: 'imports', name: 'Imports', desc: 'Bring jobs, customers, vendors and open balances in from your old system', href: '/setup/imports' }] : []),
  ];
  const title = [...companyAreas, ...workspaceAreas].find((a) => a.key === area)!.name;

  return (
    <>
      <PageLine facts={[company.name, { label: pack ? `${pack.name} ${pack.pack_version}` : 'Not set up', strong: true }, `${count(modules.length)} modules on`]} />
      <Page>
        <PageHead eyebrow="Settings" title="Settings" />
        <div className="cols" style={{ marginTop: 0 }}>
          <SettingsIndex
            company={{ id: company.id, name: company.name }}
            companies={installed.map((c) => ({ id: c.id, name: c.name }))}
            orgName={scope.tenant.orgName ?? 'Workspace'}
            current={area}
            companyAreas={companyAreas}
            workspaceAreas={workspaceAreas}
          />
          <section className="sec" aria-labelledby="area-title">
            <div className="sec-h">
              <h2 className="t-section" id="area-title">{title}</h2>
              <span className="sp" />
              {['industry', 'job-types', 'stages', 'modules', 'vocabulary'].includes(area) && !scope.readOnly && configures && <ButtonLink href={changeHref}>Change setup</ButtonLink>}
            </div>

            {area === 'industry' &&
              (pack ? (
                <div className="stack">
                  <KV items={[{ term: 'Industry pack', value: pack.name }, { term: 'Version', value: pack.pack_version }, { term: 'Installed', value: stamp(pack.installed_at) }, { term: 'Job types', value: count(jobTypes.length) }, { term: 'Cost codes', value: count(codes.length) }]} />
                  {pack.tagline && <p className="ink-2">{pack.tagline}</p>}
                  <InlineNotice title="Setup is read-only here.">Change setup re-runs the industry questions and shows what will change before anything is applied. Jobs already in progress keep their stage.</InlineNotice>
                </div>
              ) : (
                <WidgetState state={{ kind: 'empty', title: 'This company is not set up', action: <ButtonLink variant="primary" href={`/onboarding?company=${company.id}`}>Set up {company.name}</ButtonLink> }} />
              ))}

            {area === 'job-types' && (
              <table className="tbl tbl-q tbl-q--compact">
                <thead><tr><th>Job type</th><th>Billing</th><th>Progress</th><th>Stages</th></tr></thead>
                <tbody>
                  {jobTypes.map((t) => (
                    <tr key={t.id} className="q-row">
                      <td><span className="l1">{t.label}</span><span className="l2">{t.archetype.replace(/_/g, ' ')}</span></td>
                      <td><span className="l1" style={{ fontWeight: 400 }}>{cap(BILLING_MODE_LABELS[t.default_billing_mode as BillingMode] ?? t.default_billing_mode)}</span><span className="l2">{t.billing_modes.length > 1 ? `also ${t.billing_modes.filter((m) => m !== t.default_billing_mode).map((m) => BILLING_MODE_LABELS[m as BillingMode] ?? m).join(', ')}` : ' '}</span></td>
                      <td>{cap(PROGRESS_BASIS_LABELS[t.progress_basis])}</td>
                      <td>{machines.find((m) => m.machineKey === t.stage_machine_key)?.stages.length ?? 0}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            {area === 'stages' && (
              <div className="stack">
                {machines.map((m) => {
                  const users = jobTypes.filter((t) => t.stage_machine_key === m.machineKey).map((t) => t.label);
                  const label = new Map(m.stages.map((s) => [s.stage_key, s.label]));
                  return (
                    <div key={m.machineKey}>
                      <div className="t-head">{users.join(', ') || m.machineKey}</div>
                      <ol className="ar" aria-label={`Stages for ${users.join(', ')}`}>
                        {m.stages.map((s, i) => {
                          const st = stageStatus(s.core_status);
                          const out = m.transitions.filter((t) => t.from_stage === s.stage_key);
                          return (
                            <li key={s.stage_key}>
                              <span className="no" aria-hidden="true">{i + 1}</span>
                              <span style={{ minWidth: 0 }}>
                                <span className="nm">{s.label}{s.is_initial ? <Tag>First</Tag> : null}{s.is_terminal ? <Tag>Final</Tag> : null}</span>
                                <span className="ds" style={{ whiteSpace: 'normal' }}>
                                  {out.length ? out.map((t) => `To ${label.get(t.to_stage) ?? t.to_stage}: ${guardsSentence(t.guards).replace(/^Needs/, 'needs').replace(/^No checks\./, 'no checks.')}`).join(' ') : 'No moves out.'}
                                </span>
                              </span>
                              <span className="st"><Status kind={st.kind} pip={st.pip}>{CORE_STATUS_WORDS[s.core_status]}</Status></span>
                            </li>
                          );
                        })}
                      </ol>
                    </div>
                  );
                })}
                <p className="t-cap">The status on the right is what Merit Books sees for a job in that stage.</p>
              </div>
            )}

            {area === 'modules' && (
              <div className="stack">
                <ul style={{ listStyle: 'none' }}>
                  {MODULES.map((m) => (
                    <li key={m} className="row row--between" style={{ height: 40, borderBottom: '1px solid var(--line)' }}>
                      <span>{MODULE_LABELS[m]}</span>
                      <Switch aria-label={MODULE_LABELS[m]} checked={modules.includes(m)} disabled readOnly />
                    </li>
                  ))}
                </ul>
                <p className="t-cap">Read-only here. Modules follow the industry setup; Change setup turns them on or off for every job type at once.</p>
              </div>
            )}

            {area === 'vocabulary' && (
              <table className="tbl tbl-q tbl-q--compact">
                <thead><tr><th>Standard term</th><th>{company.name} says</th></tr></thead>
                <tbody>
                  {(Object.keys(DEFAULT_VOCAB) as VocabKey[]).map((k) => (
                    <tr key={k} className="q-row">
                      <td>{DEFAULT_VOCAB[k]}</td>
                      <td>{vocab[k]}{vocab[k] !== DEFAULT_VOCAB[k] ? <> <Tag tone="ai">Renamed</Tag></> : null}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            {area === 'cost-codes' && <CostCodesEditor companyId={company.id} codes={codes} />}

            {area === 'labor' && labor && (
              <LaborRatesEditor
                companyId={company.id}
                settings={labor[0]}
                rates={rates}
                employeeCards={labor[1]}
                employees={labor[2].map((e) => ({ id: e.id, name: personName(e) }))}
              />
            )}

            {area === 'team' && team && (
              <TeamArea
                companyName={company.name}
                error={team.error}
                rows={team.members.map((m) => ({
                  membershipId: m.membershipId, name: m.name, email: m.email, booksRole: m.booksRole, status: m.status, isMe: m.isMe,
                  titles: [...new Set(rolesAt(m, company.id).map(titleOf))],
                  isAdminSeat: m.isAdminSeat, projectsOnly: m.projectsOnly,
                }))}
                preview={
                  real && canPreview(real.grants)
                    ? {
                        personas: PERSONAS.map((k) => {
                          const t = roleTitleFor(exp?.experience, k);
                          return { key: k, label: t && t !== PERSONA_LABEL[k] ? `${t} (${PERSONA_LABEL[k]})` : PERSONA_LABEL[k] };
                        }),
                        current: access.preview,
                      }
                    : null
                }
                booksTeamUrl={`${booksUrl()}/settings/team`}
                // Owner-visible only: the REAL grants (never a preview) must configure Projects and edit this company's team.
                canSetProjectsOnly={!scope.readOnly && !!real && canPreview(real.grants) && holds(real, 'projects.team:edit', company.id)}
              />
            )}

            {area === 'onboarding' &&
              (uninstalled.length ? (
                <ul className="ar">
                  {uninstalled.map((c, i) => (
                    <li key={c.id} className="is-attn">
                      <span className="no" aria-hidden="true">{i + 1}</span>
                      <span><span className="nm">{c.name}</span><span className="ds">Not running on Merit Projects yet</span></span>
                      <span className="st"><ButtonLink href={`/onboarding?company=${c.id}`}>Set up</ButtonLink></span>
                    </li>
                  ))}
                </ul>
              ) : (
                <WidgetState state={{ kind: 'done', title: 'Every company is set up', body: `${count(installed.length)} ${installed.length === 1 ? 'company runs' : 'companies run'} on Merit Projects.` }} />
              ))}
          </section>
        </div>
      </Page>
    </>
  );
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
