'use client';

import { useMemo, useState } from 'react';
import { Button, Check, ConfirmDialog, Drawer, Field, Input, KV, Select, Tag, Textarea, money } from '@meritbooks/merit-ui';
import { pctText } from '@/lib/commercial/labels';
import type { ProjectTemplate, TemplateApplication, TemplatePayload } from '@/lib/commercial/screen-types';
import type { JobOption } from '@/lib/pm/ops/scope';
import { useShell } from '@/components/shell/ShellContext';
import { JobSelect, PctInput } from '@/components/ops/common/bits';
import { useOps } from '@/components/ops/common/useOps';
import { DSection, Failure } from './common';
import { CmTable, TableKeys, words, type Col } from './kit';

type Act = ReturnType<typeof useOps>['act'];
type Settings = NonNullable<TemplatePayload['contract_settings']>;

/** Jobs on a template and how many run an older version (the global update's reach). Pure. */
export function templateReach(t: Pick<ProjectTemplate, 'id' | 'version'>, apps: ReadonlyArray<TemplateApplication>, openJobs: ReadonlySet<string>): { jobs: number; behind: number } {
  const mine = apps.filter((a) => a.template_id === t.id && openJobs.has(a.job_id));
  return { jobs: mine.length, behind: mine.filter((a) => a.version < t.version).length };
}

/**
 * Project templates with global update (CGC-06): ground-up, tenant improvement, occupied
 * renovation, healthcare (ICRA), public / prevailing wage, and the trade templates (install only,
 * furnish and install, service to project). Each carries contract settings, retainage step-downs,
 * markups, compliance requirements, closeout items and meeting series. Editing bumps the version;
 * "Push to open jobs" re-applies it to every open job on an older version.
 */
export function TemplatesView({ templates, applications, jobs, companies, canConfigure, canApply }: {
  templates: ProjectTemplate[]; applications: TemplateApplication[]; jobs: JobOption[]; companies: Array<{ id: string; name: string }>; canConfigure: boolean; canApply: boolean;
}) {
  const { readOnly } = useShell();
  const { act, busy, error } = useOps();
  const [openId, setOpenId] = useState<string | null>(null);
  const [showInactive, setShowInactive] = useState(false);
  const [seedCo, setSeedCo] = useState(companies[0]?.id ?? '');
  const openJobs = useMemo(() => new Set(jobs.filter((j) => j.open).map((j) => j.id)), [jobs]);
  const coName = useMemo(() => new Map(companies.map((c) => [c.id, c.name])), [companies]);
  const shown = templates.filter((t) => showInactive || t.is_active);
  const open = templates.find((t) => t.id === openId) ?? null;
  const edit = !readOnly && canConfigure;

  const cols: Col<ProjectTemplate>[] = [
    { key: 'name', head: 'Template', cell: (t) => <><span className="b">{t.name}</span>{!t.is_active && <> <Tag>Inactive</Tag></>}<span className="ops-sub" style={{ display: 'block' }}>{t.description ?? words(t.kind)}</span></> },
    { key: 'kind', head: 'Kind', width: 180, cell: (t) => words(t.kind) },
    { key: 'co', head: 'Company', width: 150, cell: (t) => (t.location_id ? coName.get(t.location_id) ?? '—' : 'Every company') },
    { key: 'v', head: 'Version', n: true, width: 80, cell: (t) => t.version },
    { key: 'jobs', head: 'Open jobs', n: true, width: 100, cell: (t) => templateReach(t, applications, openJobs).jobs || '—' },
    { key: 'behind', head: 'On an older version', width: 160, cell: (t) => { const b = templateReach(t, applications, openJobs).behind; return b ? <Tag tone="warn">{b} to update</Tag> : '—'; } },
  ];

  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="ops-toolbar">
        <Check label="Show inactive" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
        <span className="sp" />
        {edit && companies.length > 1 && <Field label="Company"><Select value={seedCo} onChange={(e) => setSeedCo(e.target.value)}>{companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></Field>}
        {edit && seedCo && <Button disabled={busy !== null} onClick={() => void act<{ seeded: number }>('seed', 'post', '/api/commercial/templates', { op: 'seed', companyId: seedCo }, (d) => (d.seeded ? `Added ${d.seeded} standard templates and the QA / safety checklists` : 'The standard templates are already there'))}>{busy === 'seed' ? 'Adding…' : 'Add the standard templates'}</Button>}
      </div>
      <Failure text={error} />
      <CmTable label="Project templates" keys rows={shown} cols={cols} rowKey={(t) => t.id} onOpen={(t) => setOpenId(t.id)} activeId={openId}
        rowTone={(t) => (templateReach(t, applications, openJobs).behind ? 'warn' : null)}
        empty={{ title: 'No project templates yet', body: 'Add the standard set — ground-up, tenant improvement, occupied renovation, healthcare, public works and the three trade templates — then tailor them. Each job picks one when it starts.' }} />
      <TableKeys />
      <Drawer open={!!open} onClose={() => setOpenId(null)} width={620} title={open?.name ?? ''} eyebrow={open ? `${words(open.kind)} // version ${open.version}` : undefined}>
        {open && <TemplateDetail key={`${open.id}:${open.version}`} t={open} reach={templateReach(open, applications, openJobs)} jobs={jobs.filter((j) => j.open && (!open.location_id || j.companyId === open.location_id))}
          edit={edit} apply={!readOnly && canApply} busy={busy} act={act} companies={companies} />}
      </Drawer>
    </div>
  );
}

function TemplateDetail({ t, reach, jobs, edit, apply, busy, act, companies }: {
  t: ProjectTemplate; reach: { jobs: number; behind: number }; jobs: JobOption[]; edit: boolean; apply: boolean; busy: string | null; act: Act; companies: Array<{ id: string; name: string }>;
}) {
  const url = `/api/commercial/templates/${t.id}`;
  const cs0 = t.payload.contract_settings ?? {};
  const [name, setName] = useState(t.name);
  const [desc, setDesc] = useState(t.description ?? '');
  const [cs, setCs] = useState<Settings>(cs0);
  const [steps, setSteps] = useState((t.payload.retainage_steps ?? []).map((s) => ({ ...s })));
  const [jobId, setJobId] = useState('');
  const [confirmPush, setConfirmPush] = useState(false);
  const [copyName, setCopyName] = useState(`${t.name} (copy)`);
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setCs((x) => ({ ...x, [k]: v }));
  const num = (v: string, lo: number, hi: number) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : undefined; };

  return (
    <div className="stack" style={{ gap: 20 }}>
      {apply && (
        <DSection title="Apply to a job">
          <div className="row" style={{ gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <Field label="Job"><JobSelect jobs={jobs} value={jobId} onChange={setJobId} /></Field>
            <Button variant="primary" disabled={!jobId || busy !== null} onClick={() => void act<{ markup_rules: number; retainage_steps: number; closeout_items: number; meetings: number }>('apply', 'post', '/api/commercial/templates', { op: 'apply', jobId, templateId: t.id },
              (d) => `Applied: ${d.markup_rules} markups, ${d.retainage_steps} retainage steps, ${d.closeout_items} closeout items, ${d.meetings} meeting series`)}>{busy === 'apply' ? 'Applying…' : 'Apply'}</Button>
          </div>
          <p className="t-cap" style={{ marginTop: 8 }}>Re-applying replaces what the template set before; anything added by hand on the job is kept.</p>
        </DSection>
      )}
      {edit && reach.behind > 0 && (
        <DSection title="Global update">
          <p className="t-cap" style={{ marginBottom: 8 }}>{reach.behind} of {reach.jobs} open {reach.jobs === 1 ? 'job runs' : 'jobs run'} an older version.</p>
          <Button variant="primary" disabled={busy !== null} onClick={() => setConfirmPush(true)}>Push version {t.version} to {reach.behind} {reach.behind === 1 ? 'job' : 'jobs'}</Button>
        </DSection>
      )}
      <DSection title="Contract settings">
        {edit ? (
          <div className="stack" style={{ gap: 8 }}>
            <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              <Field label="Change tiers"><Select value={String(cs.change_tiers ?? 2)} onChange={(e) => set('change_tiers', Number(e.target.value))}><option value="1">1 — COR to the GC</option><option value="2">2 — PCO → CO</option><option value="3">3 — CE → PCO → COR → CO</option></Select></Field>
              <Field label="Billing cutoff day"><Input inputMode="numeric" value={String(cs.billing_cutoff_day ?? 25)} onChange={(e) => set('billing_cutoff_day', num(e.target.value, 1, 31))} style={{ width: 70 }} /></Field>
              <Field label="Billing form"><Select value={cs.billing_form ?? 'AIA'} onChange={(e) => set('billing_form', e.target.value)}>{['AIA', 'GC_FORM', 'OWNER_FORM', 'TEXTURA', 'GCPAY', 'PROCORE_PAY', 'OTHER'].map((f) => <option key={f} value={f}>{words(f)}</option>)}</Select></Field>
            </div>
            <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              <Field label="Retainage step-down applies to"><Select value={cs.retainage_step_mode ?? 'NEW_WORK_ONLY'} onChange={(e) => set('retainage_step_mode', e.target.value)}><option value="NEW_WORK_ONLY">New work only</option><option value="REDUCE_TO_DATE">The whole balance</option></Select></Field>
              <Field label="Stored materials rate" help="Blank: same as work"><PctInput value={cs.stored_retainage_pct ?? null} onChange={(v) => set('stored_retainage_pct', v ?? undefined)} /></Field>
              <Field label="RFI response days"><Input inputMode="numeric" value={String(cs.rfi_default_days ?? 7)} onChange={(e) => set('rfi_default_days', num(e.target.value, 1, 90))} style={{ width: 70 }} /></Field>
              <Field label="Submittal review days"><Input inputMode="numeric" value={String(cs.submittal_review_days ?? 10)} onChange={(e) => set('submittal_review_days', num(e.target.value, 1, 90))} style={{ width: 70 }} /></Field>
            </div>
            <div className="row" style={{ gap: 16, flexWrap: 'wrap' }}>
              <Check label="Architect certifies pay apps" checked={cs.architect_certification ?? true} onChange={(e) => set('architect_certification', e.target.checked)} />
              <Check label="Bonded" checked={cs.bonded ?? false} onChange={(e) => set('bonded', e.target.checked)} />
              <Check label="Prevailing wage" checked={cs.prevailing_wage ?? false} onChange={(e) => set('prevailing_wage', e.target.checked)} />
            </div>
          </div>
        ) : (
          <KV items={Object.entries(cs0).map(([k, v]) => ({ term: words(k), value: typeof v === 'boolean' ? (v ? 'Yes' : 'No') : String(v) }))} />
        )}
      </DSection>
      <DSection title="Retainage step-downs" aside={edit ? <Button variant="quiet" onClick={() => setSteps((s) => [...s, { side: 'RECEIVABLE', from_pct: 0.5, rate: 0.05 }])}>Add a step</Button> : undefined}>
        {steps.length === 0 ? <p className="t-cap">The contract rate holds to the end.</p> : (
          <div className="stack" style={{ gap: 6 }}>
            {steps.map((s, i) => edit ? (
              <div key={i} className="row" style={{ gap: 8, alignItems: 'flex-end' }}>
                <Field label="Side"><Select value={s.side ?? 'RECEIVABLE'} onChange={(e) => setSteps((x) => x.map((y, j) => (j === i ? { ...y, side: e.target.value } : y)))}><option value="RECEIVABLE">From the owner</option><option value="PAYABLE">To subs</option></Select></Field>
                <Field label="From complete"><PctInput value={s.from_pct} onChange={(v) => setSteps((x) => x.map((y, j) => (j === i ? { ...y, from_pct: v ?? 0 } : y)))} /></Field>
                <Field label="Rate"><PctInput value={s.rate} onChange={(v) => setSteps((x) => x.map((y, j) => (j === i ? { ...y, rate: v ?? 0 } : y)))} /></Field>
                <Button variant="quiet" onClick={() => setSteps((x) => x.filter((_, j) => j !== i))}>Remove</Button>
              </div>
            ) : <p key={i}>{s.side === 'PAYABLE' ? 'To subs' : 'From the owner'}: {pctText(s.rate, 1)} from {pctText(s.from_pct)} complete</p>)}
          </div>
        )}
      </DSection>
      <DSection title="Markups">
        {(t.payload.markup_rules ?? []).length === 0 ? <p className="t-cap">None.</p> : (
          <KV items={(t.payload.markup_rules ?? []).map((m) => ({ term: m.label ?? words(m.kind), value: `${pctText(m.pct, 1)}${m.compounding ? ' compounding' : ''}${m.applies_to && m.applies_to !== 'ALL' ? ` · ${words(m.applies_to)}` : ''}` }))} />
        )}
      </DSection>
      <DSection title="Compliance and closeout">
        <KV items={[
          { term: 'Compliance requirements', value: (t.payload.compliance_requirements ?? []).map((r) => `${words(r.requirement)}${r.min_limit_cents ? ` ${money(r.min_limit_cents, { decimals: 0 })}` : ''}`).join('; ') || 'None' },
          { term: 'Closeout items', value: (t.payload.closeout ?? []).map((c) => c.title).join('; ') || 'The standard package' },
          { term: 'Meeting series', value: (t.payload.meetings ?? []).map((m) => m.title ?? words(m.type)).join('; ') || 'None' },
        ]} />
      </DSection>
      {edit && (
        <DSection title="Name and status">
          <div className="stack" style={{ gap: 8 }}>
            <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} /></Field>
            <Field label="Description"><Textarea value={desc} onChange={(e) => setDesc(e.target.value)} maxLength={2000} /></Field>
            <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              <Button variant="primary" chord="mod+s" bindChord disabled={busy !== null || !name.trim()} onClick={() => void act<{ version: number }>('save', 'patch', url, {
                name: name.trim(), description: desc.trim() || null, payload: { contract_settings: Object.fromEntries(Object.entries(cs).filter(([, v]) => v !== undefined)), retainage_steps: steps },
              }, (d) => `Saved — now version ${d.version}`)}>{busy === 'save' ? 'Saving…' : 'Save'}</Button>
              <Button disabled={busy !== null} onClick={() => void act('active', 'patch', url, { isActive: !t.is_active }, t.is_active ? 'Deactivated the template' : 'Reactivated the template')}>{t.is_active ? 'Deactivate' : 'Reactivate'}</Button>
            </div>
            <div className="row" style={{ gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
              <Field label="Copy as"><Input value={copyName} onChange={(e) => setCopyName(e.target.value)} maxLength={120} /></Field>
              <Button disabled={busy !== null || !copyName.trim() || !(t.location_id ?? companies[0]?.id)} onClick={() => void act('copy', 'post', url, { op: 'duplicate', name: copyName.trim(), companyId: t.location_id ?? companies[0]?.id }, 'Copied the template')}>Duplicate</Button>
            </div>
          </div>
        </DSection>
      )}
      <ConfirmDialog open={confirmPush} onClose={() => setConfirmPush(false)} title={`Push version ${t.version} to ${reach.behind} open ${reach.behind === 1 ? 'job' : 'jobs'}?`} confirmLabel="Push the update"
        onConfirm={async () => { await act<{ jobs: number }>('push', 'post', '/api/commercial/templates', { op: 'push', templateId: t.id }, (d) => `Updated ${d.jobs} ${d.jobs === 1 ? 'job' : 'jobs'} to version ${t.version}`); setConfirmPush(false); }}>
        Each job’s template-set markups, retainage steps and compliance requirements are replaced with this version’s; closeout items and meetings are added where missing. Settings changed by hand on a job are overwritten for the fields the template sets.
      </ConfirmDialog>
    </div>
  );
}
