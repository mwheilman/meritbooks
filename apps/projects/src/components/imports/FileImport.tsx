'use client';

import { useMemo, useState } from 'react';
import { AiPaused, Button, Field, Icon, InlineNotice, Pip, Select, Tag, count, money, toast } from '@meritbooks/merit-ui';
import { ENTITY_DEFS } from '@/lib/imports/fields';
import type { CommitResult, ImportEntity, OpeningKind, SourceSystem, StagedRow } from '@/lib/imports/types';
import { postForm, postJson } from './api';
import { trackImport } from './activity';
import type { CommitResponse, PreviewResponse } from './types';

type State =
  | { kind: 'idle' }
  | { kind: 'reading'; fileName: string }
  | { kind: 'preview'; file: File; data: PreviewResponse; overrides: Record<string, string | null> }
  | { kind: 'committing'; file: File; data: PreviewResponse }
  | { kind: 'done'; data: PreviewResponse; result: CommitResult; openingKind: OpeningKind | null }
  | { kind: 'error'; message: string };

const OUTCOME_WORD: Record<string, string> = { CREATED: 'added', MATCHED: 'linked to records you already had', SKIPPED: 'already here or not brought in', ERROR: 'need a look', REFERENCE: 'kept as history', ROSTER: 'ready for the crew step', FACT: 'kept for the opening balances' };

function cell(v: unknown, key: string): string {
  if (v == null || v === '') return '—';
  if (typeof v === 'number' && /_cents$/.test(key)) return money(v);
  if (typeof v === 'number' && key === 'pct_complete') return `${Math.round(v * 1000) / 10}%`;
  if (Array.isArray(v)) return v.join(', ');
  return String(v);
}

function rowPip(r: StagedRow) {
  return r.validation === 'INVALID' ? 'blocked' : r.validation === 'WARN' ? 'risk' : 'ready';
}

/** One export file: drop → preview (the 0–3 unsure columns, the report, the first rows) → bring in / undo. */
export function FileImport({ companyId, source, entity, label, onCommitted, compact = false }: {
  companyId: string;
  source: SourceSystem | null;
  entity: ImportEntity | null;
  label: string;
  onCommitted?: (r: { entity: ImportEntity; result: CommitResult; openingKind: OpeningKind | null; fileName: string }) => void;
  compact?: boolean;
}) {
  const [state, setState] = useState<State>({ kind: 'idle' });
  const [openOnly, setOpenOnly] = useState(true);

  const read = async (file: File, overrides: Record<string, string | null> = {}, open = openOnly) => {
    const id = `${companyId}:${source ?? 'any'}:${entity ?? 'any'}:${file.name}`;
    setState({ kind: 'reading', fileName: file.name });
    trackImport({ id, label: file.name, phase: 'reading', detail: null });
    const form = new FormData();
    form.set('file', file);
    form.set('companyId', companyId);
    if (source) form.set('source', source);
    if (entity) form.set('entity', entity);
    if (Object.keys(overrides).length) form.set('overrides', JSON.stringify(overrides));
    if (!open) form.set('openOnly', '0');
    const r = await postForm<PreviewResponse>('/api/imports/preview', form);
    if (!r.ok) {
      trackImport({ id, label: file.name, phase: 'error', detail: r.error });
      setState({ kind: 'error', message: r.error });
      return;
    }
    if (r.data.staged.status === 'COMMITTED' && r.data.staged.result) {
      trackImport({ id, label: file.name, phase: 'done', detail: 'already brought in' });
      setState({ kind: 'done', data: r.data, result: { ...r.data.staged.result, replayed: true }, openingKind: null });
      return;
    }
    trackImport({ id, label: file.name, phase: 'staged', detail: `${count(r.data.preview.report.valid + r.data.preview.report.warn)} rows` });
    setState({ kind: 'preview', file, data: r.data, overrides });
  };

  const commit = async () => {
    if (state.kind !== 'preview') return;
    const { file, data } = state;
    const id = `${companyId}:${source ?? 'any'}:${entity ?? 'any'}:${file.name}`;
    setState({ kind: 'committing', file, data });
    trackImport({ id, label: file.name, phase: 'committing', detail: null });
    const r = await postJson<CommitResponse>(`/api/imports/${data.batchId}/commit`, {});
    if (!r.ok) {
      trackImport({ id, label: file.name, phase: 'error', detail: r.error });
      setState({ kind: 'preview', file, data, overrides: {} });
      toast(r.error, { tone: 'neg' });
      return;
    }
    const c = r.data.result.counts;
    trackImport({ id, label: file.name, phase: (c.ERROR ?? 0) > 0 ? 'error' : 'done', detail: `${count((c.CREATED ?? 0) + (c.MATCHED ?? 0) + (c.REFERENCE ?? 0) + (c.FACT ?? 0) + (c.ROSTER ?? 0))} in` });
    setState({ kind: 'done', data, result: r.data.result, openingKind: r.data.openingKind });
    onCommitted?.({ entity: data.preview.entity, result: r.data.result, openingKind: r.data.openingKind, fileName: file.name });
  };

  const discard = async () => {
    if (state.kind !== 'preview') return;
    const r = await postJson<{ status: string }>(`/api/imports/${state.data.batchId}/discard`, {});
    if (!r.ok) { toast(r.error, { tone: 'neg' }); return; }
    toast(`Undid ${state.file.name}; nothing was brought in.`);
    setState({ kind: 'idle' });
  };

  const drop = (
    <label className="ob-drop">
      <input type="file" accept=".csv,.xlsx,.xlsm,.txt,.tsv" aria-label={`Choose the ${label.toLowerCase()} file`}
        onChange={(e) => { const f = e.currentTarget.files?.[0]; if (f) void read(f); e.currentTarget.value = ''; }} />
      <Icon name="upload" />
      <span className="l1">{state.kind === 'reading' ? `Reading ${state.fileName}…` : `Drop the ${label.toLowerCase()} export`}</span>
    </label>
  );

  if (state.kind === 'idle' || state.kind === 'reading' || state.kind === 'error') {
    return (
      <div className={compact ? 'imp-file imp-file--compact' : 'imp-file'}>
        {drop}
        {state.kind === 'error' && <InlineNotice tone="neg" title={state.message} />}
      </div>
    );
  }

  if (state.kind === 'done') return <CommitSummary data={state.data} result={state.result} onAnother={() => setState({ kind: 'idle' })} />;

  return (
    <PreviewCard
      data={state.data}
      busy={state.kind === 'committing'}
      openOnly={openOnly}
      onOpenOnly={(v) => { setOpenOnly(v); if (state.kind === 'preview') void read(state.file, state.overrides, v); }}
      onChoose={(field, header) => { if (state.kind === 'preview') void read(state.file, { ...state.overrides, [field]: header }); }}
      onCommit={commit}
      onDiscard={discard}
    />
  );
}

function PreviewCard({ data, busy, openOnly, onOpenOnly, onChoose, onCommit, onDiscard }: {
  data: PreviewResponse;
  busy: boolean;
  openOnly: boolean;
  onOpenOnly: (v: boolean) => void;
  onChoose: (field: string, header: string | null) => void;
  onCommit: () => void;
  onDiscard: () => void;
}) {
  const p = data.preview;
  const def = ENTITY_DEFS[p.entity];
  const shownFields = useMemo(() => def.fields.filter((f) => p.mapping[f.key]).slice(0, 5), [def, p.mapping]);
  const bringing = p.report.valid + p.report.warn;
  return (
    <section className="ob-card imp-preview" aria-label={`Preview of ${p.fileName}`}>
      <div className="ob-card-h">
        <h3>{p.fileName}</h3>
        <span className="t-cap tnum">{count(p.rowCount)} rows · {p.source === 'CSV' ? 'spreadsheet' : p.source.replace('_', ' ').toLowerCase()} {def.plural}</span>
        {p.detection.confidence < 0.6 && <Tag tone="warn">Check what this file is</Tag>}
        <span className="sp" />
        <Button variant="quiet" disabled={busy} onClick={onDiscard} icon="undo">Undo</Button>
      </div>

      {p.ai.outcome === 'paused' && p.unsure.length > 0 && (
        <div className="ob-card-b"><AiPaused>Columns were matched by their names and values. Check the {p.unsure.length === 1 ? 'one' : p.unsure.length} below.</AiPaused></div>
      )}

      {p.unsure.length > 0 && (
        <div className="imp-unsure" aria-label="Columns to check">
          {p.unsure.map((u) => (
            <Field key={u.field} label={<>{u.label}{u.required ? ' (needed)' : ''}</>} help={u.samples.length ? `e.g. ${u.samples.join(' · ')}` : u.why}>
              <Select value={u.header ?? ''} onChange={(e) => onChoose(u.field, e.currentTarget.value || null)} disabled={busy} className={u.required && !u.header ? 'is-low' : undefined}>
                <option value="">No column</option>
                {p.headers.map((h) => <option key={h} value={h}>{h}</option>)}
              </Select>
            </Field>
          ))}
        </div>
      )}

      <div className="imp-report">
        <div className="imp-kpis">
          <span><b className="tnum">{count(p.report.valid)}</b> ready</span>
          <span><b className="tnum">{count(p.report.warn)}</b> with a note</span>
          <span><b className="tnum">{count(p.report.invalid)}</b> not brought in</span>
          {p.report.duplicates > 0 && <span><b className="tnum">{count(p.report.duplicates)}</b> repeated</span>}
        </div>
        {data.entityReport && <EntityReport report={data.entityReport} importer={data.importerReport} />}
        {p.report.topIssues.length > 0 && (
          <ul className="ob-list">
            {p.report.topIssues.slice(0, 5).map((i) => (
              <li key={i.message}><b className="tnum">{count(i.count)}×</b> {i.message} <span className="t-cap">rows {i.rows.slice(0, 6).join(', ')}{i.rows.length > 6 ? '…' : ''}</span></li>
            ))}
          </ul>
        )}
        {p.entity === 'job' && (
          <label className="imp-toggle"><input type="checkbox" checked={!openOnly} onChange={(e) => onOpenOnly(!e.currentTarget.checked)} disabled={busy} /> Also bring finished and cancelled jobs (as history)</label>
        )}
      </div>

      <div className="ob-tbl">
        <table className="tbl tbl-q tbl-q--flush tbl-q--compact" aria-label="First rows">
          <thead><tr><th>Row</th><th>Status</th>{shownFields.map((f) => <th key={f.key}>{f.label}</th>)}<th>Note</th></tr></thead>
          <tbody>
            {p.rows.slice(0, 10).map((r) => (
              <tr key={r.row_number}>
                <td className="tnum">{r.row_number}</td>
                <td><span className="status"><Pip kind={rowPip(r)} />{r.validation === 'INVALID' ? 'Skip' : r.validation === 'WARN' ? 'Note' : 'Ready'}</span></td>
                {shownFields.map((f) => <td key={f.key} className={/_cents$/.test(f.key) ? 'num tnum' : undefined}>{cell(r.data[f.key], f.key)}</td>)}
                <td className="issue">{r.issues[0]?.message ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="ob-card-f">
        <span>{def.effect}</span>
        <span className="sp" />
        <Button variant="primary" disabled={busy || bringing === 0} onClick={onCommit}>{busy ? 'Bringing them in…' : `Bring in ${count(bringing)} ${bringing === 1 ? 'row' : 'rows'}`}</Button>
      </div>
    </section>
  );
}

function EntityReport({ report, importer }: { report: Record<string, unknown> & { kind: string }; importer: Record<string, unknown> | null }) {
  const n = (k: string) => (typeof report[k] === 'number' ? (report[k] as number) : 0);
  if (report.kind === 'agreements') {
    const errs = Array.isArray(importer?.errors) ? (importer!.errors as { row: number; error: string }[]) : [];
    return (
      <div className="imp-entity">
        <span><b className="tnum">{count(n('agreements'))}</b> agreements</span>
        <span><b className="tnum">{money(n('deferredCents'))}</b> deferred</span>
        <span><b className="tnum">{count(n('visitsOwed'))}</b> visits owed</span>
        {Array.isArray(report.noBilling) && (report.noBilling as unknown[]).length > 0 && <span className="neg">{(report.noBilling as unknown[]).length} with no billing</span>}
        {Array.isArray(report.noVisits) && (report.noVisits as unknown[]).length > 0 && <span className="neg">{(report.noVisits as unknown[]).length} with no visits</span>}
        {errs.length > 0 && <span className="neg">{errs.length} can’t be created yet ({errs[0]!.error})</span>}
      </div>
    );
  }
  if (report.kind === 'units') {
    const lenders = (report.byLender as { lender: string; units: number; floorCents: number }[]) ?? [];
    return (
      <div className="imp-entity">
        <span><b className="tnum">{count(n('units'))}</b> units at <b className="tnum">{money(n('costCents'))}</b></span>
        <span><b className="tnum">{count(n('flooredUnits'))}</b> floored, <b className="tnum">{money(n('floorCents'))}</b> owed</span>
        {lenders.map((l) => <span key={l.lender}>{l.lender}: {count(l.units)} · {money(l.floorCents)}</span>)}
      </div>
    );
  }
  if (report.kind === 'wip') {
    return (
      <div className="imp-entity">
        <span><b className="tnum">{count(n('jobs'))}</b> open jobs</span>
        <span>contract <b className="tnum">{money(n('contractCents'))}</b></span>
        <span>billed <b className="tnum">{money(n('billedCents'))}</b></span>
        <span>cost <b className="tnum">{money(n('costToDateCents'))}</b></span>
        {n('underBillingCents') > 0 && <span>under-billed <b className="tnum">{money(n('underBillingCents'))}</b></span>}
        {n('overBillingCents') > 0 && <span>over-billed <b className="tnum">{money(n('overBillingCents'))}</b></span>}
        {n('jobsWithoutEac') > 0 && <span className="neg">{count(n('jobsWithoutEac'))} without an estimated cost</span>}
      </div>
    );
  }
  return (
    <div className="imp-entity">
      <span><b className="tnum">{count(n('invoices'))}</b> open invoices</span>
      <span><b className="tnum">{count(n('customers'))}</b> customers</span>
      <span><b className="tnum">{money(n('openCents'))}</b> open</span>
    </div>
  );
}

function CommitSummary({ data, result, onAnother }: { data: PreviewResponse; result: CommitResult; onAnother: () => void }) {
  const entries = Object.entries(result.counts).filter(([, v]) => (v ?? 0) > 0);
  return (
    <section className="ob-card imp-done" aria-label={`${data.preview.fileName} brought in`}>
      <div className="ob-card-h">
        <Pip kind={(result.counts.ERROR ?? 0) > 0 ? 'risk' : 'ready'} />
        <h3>{data.preview.fileName}</h3>
        {result.replayed && <Tag>Already brought in</Tag>}
        <span className="sp" />
        <Button variant="quiet" onClick={onAnother}>Another file</Button>
      </div>
      <div className="ob-card-b">
        <ul className="ob-list">
          {entries.map(([k, v]) => <li key={k}><b className="tnum">{count(v ?? 0)}</b> {OUTCOME_WORD[k] ?? k.toLowerCase()}</li>)}
        </ul>
        {result.matched.length > 0 && (
          <p className="t-cap">Matched at the door: {result.matched.slice(0, 3).map((m) => `${m.name ?? 'row ' + m.row} → ${m.linked_to ?? 'existing'}`).join('; ')}{result.matched.length > 3 ? '…' : ''}</p>
        )}
        {result.errors.length > 0 && (
          <InlineNotice tone="warn" title={`${result.errors.length} ${result.errors.length === 1 ? 'row needs' : 'rows need'} a look`}>
            {result.errors.slice(0, 4).map((e) => `Row ${e.row}: ${e.message}`).join(' · ')}
          </InlineNotice>
        )}
      </div>
    </section>
  );
}
