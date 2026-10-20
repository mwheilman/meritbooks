'use client';

import { useMemo, useState } from 'react';
import {
  Bands, Button, Field, Input, MoneyInput, Panel, PanelSection, QueueTable, Textarea, WidgetState, count, money, shortDate, useEscapeKey,
  type QueueColumn, type QueueGroup,
} from '@meritbooks/merit-ui';
import { SELECTION_STATUS } from '@/lib/pm/ops/labels';
import { optionRange, varianceCell } from '@/lib/pm/ops/selection-math';
import type { SelectionStatusRow } from '@/lib/pm/ops/types';
import type { JobOption } from '@/lib/pm/ops/scope';
import { useShell, useVocab } from '@/components/shell/ShellContext';
import { lower } from '@/lib/pm/vocab';
import { Failure, JobSelect, StatusMark } from '../common/bits';
import { useOps } from '../common/useOps';
import { SelectionPanel } from './SelectionPanel';

type Band = 'waiting' | 'approved' | 'all';
const WAITING = new Set(['OPEN', 'PROPOSED', 'REJECTED']);
const CATEGORIES = ['Flooring', 'Tile', 'Countertops', 'Cabinets', 'Plumbing fixtures', 'Lighting', 'Hardware', 'Appliances', 'Paint', 'Windows and doors', 'Furniture', 'Fabric'];

export interface SelectionsListProps {
  rows: SelectionStatusRow[];
  jobs: JobOption[];
  today: string;
  fixedJobId?: string | null;
  initialJobId?: string | null;
  focusId?: string | null;
  onProcured?: () => void;
}

export function SelectionsList(p: SelectionsListProps) {
  const v = useVocab();
  const { readOnly } = useShell();
  const [band, setBand] = useState<Band>('waiting');
  const [jobId, setJobId] = useState(p.fixedJobId ?? p.initialJobId ?? '');
  const [cursor, setCursor] = useState<string | null>(p.focusId ?? null);
  const [creating, setCreating] = useState(false);
  const jobs = useMemo(() => new Map(p.jobs.map((j) => [j.id, j])), [p.jobs]);
  const scoped = jobId ? p.rows.filter((r) => r.job_id === jobId) : p.rows;
  const inBand = (b: Band) => scoped.filter((r) => (b === 'waiting' ? WAITING.has(r.status) : b === 'approved' ? r.status === 'APPROVED' : true));
  const rows = inBand(band);
  const groups: QueueGroup<SelectionStatusRow>[] = useMemo(() => {
    const m = new Map<string, SelectionStatusRow[]>();
    for (const r of rows) m.set(r.job_id, [...(m.get(r.job_id) ?? []), r]);
    return [...m.entries()].map(([id, rs]) => {
      const allowance = rs.filter((r) => r.status !== 'VOID').reduce((s, r) => s + (r.allowance_cents ?? 0), 0);
      const variance = rs.filter((r) => r.status === 'APPROVED').reduce((s, r) => s + (r.variance_cents ?? 0), 0);
      return { id, title: jobs.get(id)?.label ?? v.job, rows: rs, caption: `${money(allowance)} allowances · ${money(variance)} approved variance` };
    });
  }, [rows, jobs, v.job]);
  const cur = p.rows.find((r) => r.selection_id === cursor) ?? null;
  const usedJobs = useMemo(() => p.jobs.filter((j) => p.rows.some((r) => r.job_id === j.id)), [p.jobs, p.rows]);
  const overdue = scoped.filter((r) => r.is_overdue).length;

  const columns: QueueColumn<SelectionStatusRow>[] = [
    { id: 'what', header: 'Decision', cell: (r) => <><span className="l1">{r.title}</span><span className="l2">{r.category}</span></> },
    { id: 'due', header: 'Due', width: 96, cell: (r) => (r.due_on ? <span className={r.is_overdue ? 'neg b' : undefined}>{shortDate(r.due_on, p.today)}</span> : '—') },
    { id: 'al', header: 'Allowance', numeric: true, width: 120, cell: (r) => (r.allowance_cents == null ? '—' : money(r.allowance_cents)) },
    { id: 'ch', header: 'Chosen', numeric: true, width: 150, cell: (r) => (r.chosen_total_cents != null ? money(r.chosen_total_cents) : <span className="l2">{r.option_count ? optionRange(r.low_cents, r.high_cents) : 'No options'}</span>) },
    { id: 'va', header: 'Variance', numeric: true, width: 120, cell: (r) => (r.status === 'APPROVED' ? <span className={r.variance_cents && r.variance_cents > 0 ? 'b' : undefined}>{varianceCell(r.variance_cents)}</span> : '—') },
    { id: 'st', header: 'Status', width: 170, cell: (r) => <StatusMark mark={SELECTION_STATUS[r.status]} /> },
  ];

  return (
    <div className="stack">
      <div className="ops-toolbar">
        {!p.fixedJobId && usedJobs.length > 1 && (
          <Field label={v.job}><JobSelect jobs={usedJobs} value={jobId} onChange={setJobId} placeholder={`Every ${lower(v.job)}`} /></Field>
        )}
        <div style={{ flex: 1, maxWidth: 620 }}>
          <Bands<Band> aria-label={`${v.selections} by status`} value={band} onChange={setBand} items={[
            { value: 'waiting', label: 'Waiting on the client', count: count(inBand('waiting').length), caption: overdue ? `${count(overdue)} past due` : 'Open, sent or declined' },
            { value: 'approved', label: 'Approved', count: count(inBand('approved').length), caption: `${money(inBand('approved').reduce((s, r) => s + (r.variance_cents ?? 0), 0))} variance` },
            { value: 'all', label: 'All', count: count(scoped.length) },
          ]} />
        </div>
        <span className="sp" />
        {!readOnly && <Button variant="primary" icon="plus" chord="n" bindChord={!creating} onClick={() => { setCreating(true); setCursor(null); }}>New {lower(v.selection)}</Button>}
      </div>
      <div className={creating || cur ? 'ops-split has-panel' : 'ops-split'}>
        <div className="mp-table" style={{ minWidth: 0 }}>
          {rows.length === 0 ? (
            <WidgetState state={p.rows.length === 0
              ? { kind: 'empty', title: `No ${lower(v.selections)} yet`, body: `List what the client has to decide, with an allowance and a date. Add options, send them, and record the approval; the variance to the allowance is pinned at that moment.`, action: readOnly ? undefined : <Button variant="primary" onClick={() => setCreating(true)}>New {lower(v.selection)}</Button> }
              : { kind: 'done', title: band === 'waiting' ? 'The client owes nothing right now' : 'Nothing approved yet', body: 'Switch the band above to see the others.' }} />
          ) : (
            <QueueTable aria-label={v.selections} columns={columns} groups={groups} getRowId={(r) => r.selection_id} cursorId={cursor}
              onCursorChange={(id) => { setCursor(id); setCreating(false); }} onOpen={(r) => setCursor(r.selection_id)}
              rowState={(r) => ({ done: r.status === 'VOID', attn: !!r.is_overdue })} />
          )}
        </div>
        {creating ? (
          <NewSelectionPanel jobs={p.jobs.filter((j) => j.open)} jobId={jobId} fixedJobId={p.fixedJobId} onClose={() => setCreating(false)} onCreated={(id) => { setCreating(false); setCursor(id); setBand('waiting'); }} />
        ) : cur ? (
          <SelectionPanel key={cur.selection_id} id={cur.selection_id} jobLabel={jobs.get(cur.job_id)?.label ?? null} customerName={jobs.get(cur.job_id)?.customer ?? null} today={p.today} onClose={() => setCursor(null)} onProcured={p.onProcured} />
        ) : null}
      </div>
    </div>
  );
}

function NewSelectionPanel({ jobs, jobId: initialJob, fixedJobId, onClose, onCreated }: { jobs: JobOption[]; jobId: string; fixedJobId?: string | null; onClose: () => void; onCreated: (id: string) => void }) {
  const v = useVocab();
  const { act, busy, error } = useOps();
  const [jobId, setJobId] = useState(fixedJobId ?? initialJob);
  const [category, setCategory] = useState('');
  const [title, setTitle] = useState('');
  const [allowance, setAllowance] = useState<number | null>(null);
  const [due, setDue] = useState('');
  const [desc, setDesc] = useState('');
  const [err, setErr] = useState<string | null>(null);
  useEscapeKey(onClose, busy !== 'create', 'New selection');
  const submit = async () => {
    if (!jobId) return setErr(`Pick the ${lower(v.job)}.`);
    if (!category.trim() || !title.trim()) return setErr('Give it a category and a name.');
    setErr(null);
    const r = await act<{ selectionId: string }>('create', 'post', '/api/ops/selections', { jobId, category: category.trim(), title: title.trim(), allowanceCents: allowance, dueOn: due || null, description: desc.trim() || null }, `Added ${title.trim()}`);
    if (r) onCreated(r.selectionId);
  };
  return (
    <Panel eyebrow={['New', v.selection]} title={title.trim() || `New ${lower(v.selection)}`} meta="Starts open; add options next" onClose={onClose}
      foot={<div className="btn-row" style={{ justifyContent: 'flex-end', width: '100%' }}><Button onClick={onClose}>Cancel</Button><Button variant="primary" chord="mod+enter" bindChord disabled={busy === 'create'} onClick={() => void submit()}>Create</Button></div>}>
      <PanelSection>
        <form className="mp-form" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          {!fixedJobId && <Field label={v.job}><JobSelect jobs={jobs} value={jobId} onChange={setJobId} /></Field>}
          <Field label="Category" error={err ?? undefined}>
            <Input list="sel-categories" value={category} onChange={(e) => setCategory(e.target.value)} placeholder="Countertops" maxLength={80} autoFocus />
            <datalist id="sel-categories">{CATEGORIES.map((c) => <option key={c} value={c} />)}</datalist>
          </Field>
          <Field label="What the client decides"><Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Kitchen countertop and edge" maxLength={200} /></Field>
          <div className="mp-form-2">
            <Field label="Allowance" help="In the contract for this choice"><MoneyInput valueCents={allowance} onChangeCents={setAllowance} placeholder="None" /></Field>
            <Field label="Decide by"><Input type="date" value={due} onChange={(e) => setDue(e.target.value)} /></Field>
          </div>
          <Field label="Notes for the client"><Textarea value={desc} onChange={(e) => setDesc(e.target.value)} maxLength={2000} /></Field>
          <Failure text={error} />
          <button type="submit" hidden />
        </form>
      </PanelSection>
    </Panel>
  );
}
