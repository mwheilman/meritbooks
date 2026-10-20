'use client';

/**
 * /onboarding — the whole flow, one company at a time:
 *   0 select (multi-company only) → 1 describe → 2 preview → 3 bring_work → 4 team → done
 * Every step is saved on pm.onboarding_runs by the routes, so a reload resumes here.
 * Keys: Enter = the step's primary action (when focus isn't on a control), Esc = back.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { InlineNotice, Page, toast, useHotkey } from '@meritbooks/merit-ui';
import type {
  ApplyResponse, ClassifyResponse, CompanyBrief, PackTile, ParseResponse, PlanInputs, PlanPreview, RunStep, TeamMember,
} from '@/lib/onboarding/types';
import type { JobTypeOption } from '@/lib/onboarding/import/rows';
import { postForm, postJson } from './api';
import { CompanyTower, StepsBar, type TowerRow } from './progress';
import { SelectStep } from './select-step';
import { DescribeStep } from './describe-step';
import { WorkspaceStep } from './workspace-step';
import { BringStep } from './bring-step';
import { TeamStep } from './team-step';

export interface FlowProps {
  orgName: string;
  companies: CompanyBrief[];
  tiles: PackTile[];
  mode: 'first' | 'change';
  showSelect: boolean;
  queue: string[];
  jobTypesByCompany: Record<string, JobTypeOption[]>;
  team: TeamMember[];
  booksTeamUrl: string;
  aiConfigured: boolean;
  problem: string | null;
}

export interface CompanyFlow {
  step: RunStep;
  description: string;
  tile: string | null;
  file: ParseResponse | null;
  classification: ClassifyResponse | null;
  plan: PlanInputs | null;
  preview: PlanPreview | null;
  jobTypes: JobTypeOption[];
  sampleJobId: string | null;
  firstJobId: string | null;
}

function initialFor(c: CompanyBrief, mode: 'first' | 'change', jobTypes: JobTypeOption[]): CompanyFlow {
  const run = c.run;
  const base: CompanyFlow = {
    step: 'describe', description: '', tile: mode === 'change' ? c.installed?.packKey ?? null : null, file: null,
    classification: null, plan: null, preview: null, jobTypes, sampleJobId: null, firstJobId: null,
  };
  if (!run) return base;
  if (mode === 'first' && run.status === 'APPLIED') return { ...base, step: 'bring_work', classification: run.classification };
  if (run.status !== 'IN_PROGRESS') return base;
  const i = run.inputs;
  const resumed: CompanyFlow = {
    ...base,
    description: i.description ?? '',
    tile: i.tilePackKey ?? base.tile,
    classification: run.classification,
    plan: i.plan ?? null,
  };
  return { ...resumed, step: run.step === 'preview' && i.plan ? 'preview' : 'describe' };
}

const isInteractive = (el: Element | null) =>
  !!el && el !== document.body && (el.closest('button, a, input, select, textarea, [role="switch"], [contenteditable="true"]') !== null);

export function OnboardingFlow(props: FlowProps) {
  const router = useRouter();
  const byId = useMemo(() => new Map(props.companies.map((c) => [c.id, c])), [props.companies]);
  const [phase, setPhase] = useState<'select' | 'company'>(props.showSelect ? 'select' : 'company');
  const [queue, setQueue] = useState<string[]>(props.queue);
  const [index, setIndex] = useState(0);
  const [flows, setFlows] = useState<Record<string, CompanyFlow>>(() => {
    const out: Record<string, CompanyFlow> = {};
    for (const c of props.companies) out[c.id] = initialFor(c, props.mode, props.jobTypesByCompany[c.id] ?? []);
    return out;
  });
  const [busy, setBusy] = useState<null | 'select' | 'classify' | 'plan' | 'apply' | 'finish' | 'file'>(null);
  const [error, setError] = useState<string | null>(null);
  const primary = useRef<(() => void) | null>(null);

  const companyId = phase === 'company' ? queue[index] ?? null : null;
  const company = companyId ? byId.get(companyId) ?? null : null;
  const flow = companyId ? flows[companyId] : null;

  const patch = useCallback((id: string, p: Partial<CompanyFlow>) => {
    setFlows((f) => ({ ...f, [id]: { ...f[id], ...p } }));
  }, []);

  // ------------------------------------------------------------------ plan (debounced)
  const planSeq = useRef(0);
  const planTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fetchPlan = useCallback(async (id: string, inputs: PlanInputs, immediate = false) => {
    patch(id, { plan: inputs });
    if (planTimer.current) clearTimeout(planTimer.current);
    const run = async () => {
      const seq = ++planSeq.current;
      setBusy('plan');
      const r = await postJson<PlanPreview>('/api/onboarding/plan', { ...inputs, mode: props.mode });
      if (seq !== planSeq.current) return;
      setBusy(null);
      if (r.ok) { setError(null); patch(id, { preview: r.data }); }
      else setError(r.error);
    };
    if (immediate) await run();
    else planTimer.current = setTimeout(() => void run(), 250);
  }, [patch, props.mode]);

  // resume at the preview: compile again on mount
  useEffect(() => {
    if (company && flow?.step === 'preview' && flow.plan && !flow.preview) void fetchPlan(company.id, flow.plan, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId]);

  // ------------------------------------------------------------------ actions
  const confirmCompanies = async (ids: string[]) => {
    setBusy('select');
    const r = await postJson<{ selected: string[] }>('/api/onboarding/companies', { companyIds: ids });
    setBusy(null);
    if (!r.ok) { setError(r.error); return; }
    setError(null);
    const pending = r.data.selected.filter((id) => !byId.get(id)?.installed || byId.get(id)?.run?.status === 'APPLIED');
    setQueue(pending.length ? pending : r.data.selected);
    setIndex(0);
    setPhase('company');
  };

  const choosePack = (id: string, packKey: string, cls: ClassifyResponse | null) => {
    const sameAsAi = cls?.aiPackKey === packKey;
    const inputs: PlanInputs = {
      companyId: id,
      packKey,
      addons: [],
      params: cls && cls.paramsPackKey === packKey && Object.keys(cls.params).length ? cls.params : undefined,
      answers: sameAsAi ? Object.fromEntries(Object.entries(cls!.prefilledAnswers).map(([k, v]) => [k, v.value])) : {},
      moduleOverrides: {},
      aiDecisionId: cls?.decisionId ?? null,
    };
    patch(id, { step: 'preview', preview: null });
    void fetchPlan(id, inputs, true);
  };

  const classify = async () => {
    if (!company || !flow) return;
    const description = flow.description.trim();
    if (!flow.tile && !description && !flow.file) {
      setError('Pick the closest kind of work, or describe it in a sentence.');
      return;
    }
    setBusy('classify');
    setError(null);
    const r = await postJson<ClassifyResponse>('/api/onboarding/classify', {
      companyId: company.id,
      description: description || undefined,
      tilePackKey: flow.tile,
      fileHeaders: flow.file?.headers,
      fileName: flow.file?.fileName ?? null,
      mode: props.mode,
    });
    setBusy(null);
    if (!r.ok) { setError(r.error); return; }
    patch(company.id, { classification: r.data });
    const pick = flow.tile ?? (r.data.abstain ? null : r.data.candidates[0]?.packKey ?? null);
    if (pick) choosePack(company.id, pick, r.data);
  };

  const loadFile = async (file: File) => {
    if (!company) return;
    setBusy('file');
    const form = new FormData();
    form.set('file', file);
    form.set('companyId', company.id);
    form.set('ai', 'off');
    const r = await postForm<ParseResponse>('/api/onboarding/import/parse', form);
    setBusy(null);
    if (!r.ok) { setError(r.error); return; }
    setError(null);
    patch(company.id, { file: r.data });
  };

  const apply = async () => {
    if (!company || !flow?.plan || !flow.preview) return;
    setBusy('apply');
    setError(null);
    const r = await postJson<ApplyResponse>('/api/onboarding/apply', {
      ...flow.plan, mode: props.mode, expectedPlanHash: flow.preview.planHash,
    });
    setBusy(null);
    if (!r.ok) {
      setError(r.error);
      if (r.code === 'PLAN_CHANGED') void fetchPlan(company.id, flow.plan, true);
      return;
    }
    const jt = flow.preview.jobTypes.map((j) => ({ key: j.key, label: j.label, archetype: j.archetype }));
    toast(`Set up ${company.name} · ${jt.length} kinds of ${flow.preview.jobsWord.toLowerCase()}, ${flow.preview.costCodes.count} cost codes`);
    if (props.mode === 'change') {
      await finish(company.id, null);
      return;
    }
    patch(company.id, { step: 'bring_work', jobTypes: jt });
  };

  const finish = async (id: string, firstJobId: string | null) => {
    const f = flows[id];
    setBusy('finish');
    const r = await postJson<{ next: string | null; redirect: string | null }>('/api/onboarding/finish', {
      companyId: id, firstJobId: firstJobId ?? f?.firstJobId ?? null, sampleJobId: f?.sampleJobId ?? null, mode: props.mode,
    });
    setBusy(null);
    if (!r.ok) { setError(r.error); return; }
    patch(id, { step: 'done' });
    const name = byId.get(id)?.name ?? 'This company';
    const localNext = queue.slice(index + 1).find((q) => flows[q]?.step !== 'done');
    const next = r.data.next ?? localNext ?? null;
    if (next && props.mode === 'first') {
      toast(`${name} is set up. Next: ${byId.get(next)?.name ?? 'the next company'}.`);
      const at = queue.indexOf(next);
      if (at >= 0) setIndex(at);
      else { setQueue((q) => [...q, next]); setIndex(queue.length); }
      return;
    }
    const job = firstJobId ?? f?.firstJobId ?? null;
    toast(props.mode === 'change'
      ? `${name} is updated. Nothing was deleted; anything you turned off is just switched off.`
      : job
        ? `${name} is ready. Next: open the job and send the deposit request; Books numbers and posts the invoice.`
        : `${name} is ready. Next: add your first job from Jobs.`);
    router.push(r.data.redirect ?? '/');
    router.refresh();
  };

  const back = () => {
    setError(null);
    if (phase === 'company' && company && flow) {
      if (flow.step === 'preview') { patch(company.id, { step: 'describe' }); return; }
      if (flow.step === 'team') { patch(company.id, { step: 'bring_work' }); return; }
      if (flow.step === 'describe' && props.showSelect && index === 0) { setPhase('select'); return; }
    }
  };

  useHotkey('escape', () => { back(); return true; }, { owner: 'Onboarding', description: 'Back' });
  useHotkey('enter', () => {
    if (busy || isInteractive(document.activeElement)) return false;
    primary.current?.();
    return true;
  }, { owner: 'Onboarding', description: 'Next' });

  // ------------------------------------------------------------------ render
  const towerRows: TowerRow[] = queue.map((id, i) => {
    const f = flows[id];
    const c = byId.get(id);
    const step = f?.step ?? 'describe';
    return {
      id, name: c?.name ?? id, step, current: i === index && phase === 'company',
      detail: step === 'done' ? 'Ready' : i === index ? 'In progress' : i < index ? 'Ready' : 'Up next',
    };
  });

  return (
    <Page className="ob-page">
      {props.problem && <InlineNotice tone="warn" title={props.problem}>Refresh in a minute. Your choices so far are saved.</InlineNotice>}
      {phase === 'select' && (
        <SelectStep
          companies={props.companies}
          busy={busy === 'select'}
          error={error}
          onConfirm={confirmCompanies}
          primaryRef={primary}
        />
      )}
      {phase === 'company' && company && flow && (
        <>
          <CompanyTower rows={towerRows} />
          <StepsBar step={flow.step} mode={props.mode} />
          {flow.step === 'describe' && (
            <DescribeStep
              company={company}
              tiles={props.tiles}
              flow={flow}
              mode={props.mode}
              aiConfigured={props.aiConfigured}
              busy={busy}
              error={error}
              onChange={(p) => { setError(null); patch(company.id, p); }}
              onFile={loadFile}
              onSubmit={classify}
              onPick={(packKey) => choosePack(company.id, packKey, flow.classification)}
              onBack={props.showSelect && index === 0 ? back : null}
              primaryRef={primary}
            />
          )}
          {flow.step === 'preview' && (
            <WorkspaceStep
              company={company}
              flow={flow}
              mode={props.mode}
              busy={busy}
              error={error}
              onInputs={(inputs) => void fetchPlan(company.id, inputs)}
              onPick={(packKey) => choosePack(company.id, packKey, flow.classification)}
              onApply={apply}
              onBack={back}
              primaryRef={primary}
            />
          )}
          {flow.step === 'bring_work' && (
            <BringStep
              company={company}
              flow={flow}
              onPatch={(p) => patch(company.id, p)}
              onContinue={() => { setError(null); patch(company.id, { step: 'team' }); }}
              primaryRef={primary}
            />
          )}
          {flow.step === 'team' && (
            <TeamStep
              company={company}
              team={props.team}
              booksTeamUrl={props.booksTeamUrl}
              busy={busy === 'finish'}
              error={error}
              onFinish={() => void finish(company.id, flow.firstJobId)}
              onBack={back}
              primaryRef={primary}
            />
          )}
          {flow.step === 'done' && (
            <InlineNotice tone="info" title={`${company.name} is set up.`}>Taking you to the next step…</InlineNotice>
          )}
        </>
      )}
    </Page>
  );
}
