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

export const metadata: Metadata = { title: 'Settings' };

const AREA_KEYS = ['industry', 'job-types', 'stages', 'modules', 'vocabulary', 'cost-codes', 'labor', 'team', 'onboarding'] as const;
type AreaKey = (typeof AREA_KEYS)[number];

export default async function SettingsPage({ searchParams }: { searchParams: { company?: string; area?: string } }) {
  const scope = await pageScope();
  if (!scope) return null;
  const db = await requireDb();
  const installed = scope.installedCompanies;
  const company = installed.find((c) => c.id === searchParams.company) ?? (scope.company && installed.find((c) => c.id === scope.company!.id)) ?? installed[0]!;
  const area: AreaKey = (AREA_KEYS as readonly string[]).includes(searchParams.area ?? '') ? (searchParams.area as AreaKey) : 'industry';
  const [pack, jobTypes, machines, modules, vocab, codes, rates] = await Promise.all([
    getInstalledPack(db, company.id),
    listJobTypes(db, [company.id]),
    listStageMachines(db, company.id),
    getModules(db, company.id),
    getVocabulary(db, company.id),
    listCostCodes(db, company.id, { includeInactive: true }),
    listLaborRates(db, company.id).catch(() => []),
  ]);
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
    { key: 'labor', name: 'Labor rates', desc: 'Pay, burden and overhead: job cost versus estimating rates', status: rates.length ? `${count(rates.filter((r) => r.is_active).length)} rate cards` : 'Not set up', attn: rates.length === 0, href: href('labor') },
  ];
  const workspaceAreas: AreaLink[] = [
    { key: 'team', name: 'Team and roles', desc: 'People, roles and access are managed in Merit Books', status: 'In Merit Books', href: href('team') },
    { key: 'onboarding', name: 'Company setup', desc: 'Set up the companies that do not run on Merit Projects yet', status: uninstalled.length ? `${count(uninstalled.length)} not set up` : 'All set up', attn: uninstalled.length > 0, href: href('onboarding') },
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
              {['industry', 'job-types', 'stages', 'modules', 'vocabulary'].includes(area) && !scope.readOnly && <ButtonLink href={changeHref}>Change setup</ButtonLink>}
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

            {area === 'team' && (
              <WidgetState
                state={{
                  kind: 'empty',
                  title: 'Team settings live in Merit Books',
                  body: 'People, roles and access are shared across the suite, so they are managed in one place. A Merit Projects view of the team, with who runs which job, arrives in the next release.',
                  action: <ButtonLink href={`${booksUrl()}/settings/team`}>Open team in Merit Books</ButtonLink>,
                }}
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
