'use client';

/**
 * "Import a file" wizard (FPB §8): choose → upload → map columns (spreadsheets) or
 * review the AI read (documents) → import through the D1 routes with importBatchId →
 * outcome + links to where a person approves. Works fully with AI paused: spreadsheets
 * never need it, and a paused read steers the person to a CSV / Excel export.
 */

import { useMemo, useState } from 'react';
import { clsx } from 'clsx';
import { Check, Sparkles, X } from 'lucide-react';
import type { ImportFileKind } from '@/lib/dealer/types';
import { FILE_KIND } from '@/lib/dealer/ui/labels';
import { isStatementKind } from '@/lib/dealer/imports/fields';
import { applyMapping, reconcileMapping, splitTotalsRow, type ColumnMapping } from '@/lib/dealer/imports/mapping';
import type { ParseAi, ParseAiUnavailable, ParseMapping, ParseUnsupported } from '@/lib/dealer/imports/protocol';
import type { DealerApiError } from '@/lib/dealer/ui/errors';
import { useDealerPack } from '../../_components/dealer-shell';
import { ConfirmDialog } from '../../_components/forms';
import { ErrorPanel, Notice } from '../../_components/ui';
import { findProfile, saveProfile as persistProfile } from '../_lib/profiles';
import { abandonBatch, finishBatch, submitLenderStatement, submitOemStatement, submitRows, type BatchError } from '../_lib/submit';
import { uploadForParse } from '../_lib/upload';
import { useResolution } from '../_lib/use-resolution';
import { EMPTY_SETUP, contextFor, emptyHeader, setupProblems, type ReviewRow, type Setup } from '../_lib/wizard';
import { StepChoose } from './step-choose';
import { StepDone, type DoneState } from './step-done';
import { StepMap } from './step-map';
import { StepReview, type ReviewSubmit } from './step-review';
import { StepUpload } from './step-upload';

type Step = 'choose' | 'upload' | 'map' | 'review' | 'done';
const STEPS: Array<{ key: Step; label: string }> = [
  { key: 'choose', label: 'What' },
  { key: 'upload', label: 'Upload' },
  { key: 'map', label: 'Map / read' },
  { key: 'review', label: 'Review' },
  { key: 'done', label: 'Import' },
];

const IDLE_DONE: DoneState = { running: false, done: 0, total: 0, outcomes: [], skipped: 0, statement: null, statementError: null, finishError: null };

function AiPausedNotice({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div role="status" className="mb-4 flex flex-wrap items-start justify-between gap-3 rounded-lg border border-indigo-500/25 bg-indigo-500/[0.05] px-4 py-3 text-sm text-slate-300">
      <div className="flex min-w-0 flex-1 gap-2">
        <Sparkles size={15} className="mt-0.5 shrink-0 text-indigo-300" />
        <span>{message} The file you uploaded is kept with the import.</span>
      </div>
      <button type="button" className="btn-secondary btn-sm" onClick={onRetry}>Upload a CSV or Excel file</button>
    </div>
  );
}

export function ImportWizard({ initialKind, onClose, onFinished }: { initialKind: ImportFileKind | null; onClose: () => void; onFinished: () => void }) {
  const pack = useDealerPack();
  const locationId = pack.locationId;
  const [step, setStep] = useState<Step>('choose');
  const [setup, setSetup] = useState<Setup>({ ...EMPTY_SETUP, kind: initialKind, sourceSystem: initialKind && initialKind !== 'LENDER_STATEMENT' ? pack.settings?.dms_system ?? '' : '' });
  const [busy, setBusy] = useState(false);
  const [uploadError, setUploadError] = useState<DealerApiError | null>(null);
  const [paused, setPaused] = useState<ParseAiUnavailable | ParseUnsupported | null>(null);
  const [parse, setParse] = useState<ParseMapping | null>(null);
  const [ai, setAi] = useState<ParseAi | null>(null);
  const [batchId, setBatchId] = useState<string | null>(null);
  const [documentId, setDocumentId] = useState<string | null>(null);
  const [mapping, setMapping] = useState<ColumnMapping>({});
  const [profileNote, setProfileNote] = useState<string | null>(null);
  const [saveProfile, setSaveProfile] = useState(true);
  const [rows, setRows] = useState<ReviewRow[]>([]);
  const [header, setHeader] = useState<Record<string, string>>({});
  const [done, setDone] = useState<DoneState>(IDLE_DONE);
  const [submitError, setSubmitError] = useState<{ message: string; problems: string[] } | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);

  const kind = setup.kind;
  const mappedCells = useMemo(() => (parse && step === 'map' ? applyMapping(parse.rows, mapping) : null), [parse, mapping, step]);
  const reviewCells = useMemo(() => rows.map((r) => r.cells), [rows]);
  const resolution = useResolution(kind ?? 'UNITS', locationId, mappedCells ?? reviewCells, !!kind && (step === 'map' || step === 'review'));
  const ctx = useMemo(() => ({ ...contextFor(setup, batchId), resolve: resolution.resolve }), [setup, batchId, resolution.resolve]);
  const problems = setupProblems(setup);

  function reset() {
    setStep('choose');
    setParse(null);
    setAi(null);
    setBatchId(null);
    setDocumentId(null);
    setRows([]);
    setHeader({});
    setDone(IDLE_DONE);
    setPaused(null);
    setUploadError(null);
    setSubmitError(null);
  }

  async function onUpload(input: { file: File | null; text: string | null; useAi: boolean }) {
    if (!locationId || !kind) return;
    setBusy(true);
    setUploadError(null);
    setPaused(null);
    const res = await uploadForParse({
      locationId, fileKind: kind, sourceSystem: setup.sourceSystem, lineId: setup.lineId, oemVendorId: setup.oemVendorId,
      useAi: input.useAi, file: input.file, text: input.text,
    });
    setBusy(false);
    if (res.error || !res.data) {
      setUploadError(res.error);
      return;
    }
    const p = res.data;
    setBatchId(p.batchId);
    setDocumentId(p.sourceDocumentId);
    if (p.mode === 'ai_unavailable' || p.mode === 'unsupported') {
      setPaused(p);
      void abandonBatch(locationId, p.batchId, p.mode === 'ai_unavailable' ? 'AI reading was paused — nothing was imported. Upload a CSV or Excel export instead.' : 'This file type can’t be read for this import — nothing was imported.');
      onFinished();
      return;
    }
    if (p.mode === 'mapping') {
      setParse(p);
      const prof = findProfile(locationId, setup.sourceSystem || 'File upload', kind);
      if (prof) {
        const saved = reconcileMapping(kind, p.headers, prof.profile.mapping);
        const merged: ColumnMapping = { ...p.suggestedMapping };
        for (const [k, v] of Object.entries(saved)) if (v) merged[k] = v;
        setMapping(merged);
        setProfileNote(prof.sameClient ? 'Using the mapping you saved for this client and source.' : 'Started from a mapping saved for another client on the same source — check it.');
      } else {
        setMapping(p.suggestedMapping);
        setProfileNote(null);
      }
      setStep('map');
      return;
    }
    // AI read
    setAi(p);
    setRows(
      p.proposal.rows.map((r) => ({
        id: r.id, sourceRow: null, cells: r.cells, confidence: r.confidence, lowConfidence: r.lowConfidence, alwaysReview: r.alwaysReview, excluded: false,
      })),
    );
    setHeader({ ...emptyHeader(kind), ...Object.fromEntries(Object.entries(p.proposal.header).filter(([, v]) => v !== '')) });
    if (p.autoImported) {
      setDone({ ...IDLE_DONE, statement: { id: p.autoImported.statementId, lineCount: p.autoImported.lineCount } });
      setStep('done');
      onFinished();
      return;
    }
    setStep('review');
  }

  function mapToReview() {
    if (!parse || !kind || !locationId) return;
    const cells = applyMapping(parse.rows, mapping);
    let next: ReviewRow[] = cells.map((c, i) => ({ id: `r${i}`, sourceRow: parse.rowNumbers[i] ?? i + 1, cells: c, confidence: null, lowConfidence: false, alwaysReview: [], excluded: false }));
    let h = emptyHeader(kind);
    if (isStatementKind(kind)) {
      const split = splitTotalsRow(kind, parse.rows, cells);
      const dropped = new Set(split.dropped);
      next = next.map((r, i) => (dropped.has(i) ? { ...r, excluded: true, excludedReason: 'Totals row — used as the statement total' } : r));
      h = { ...h, ...Object.fromEntries(Object.entries(split.footer).filter((e): e is [string, string] => !!e[1])) };
    }
    if (saveProfile) persistProfile({ locationId, sourceSystem: setup.sourceSystem || 'File upload', kind, mapping, headers: parse.headers });
    setRows(next);
    setHeader((prev) => ({ ...h, ...Object.fromEntries(Object.entries(prev).filter(([, v]) => v)) }));
    setStep('review');
  }

  async function onSubmit(s: ReviewSubmit) {
    if (!locationId || !batchId || !kind) return;
    setSubmitError(null);
    if (s.type === 'lender' || s.type === 'oem') {
      setBusy(true);
      const out = s.type === 'lender' ? await submitLenderStatement(locationId, s.body) : await submitOemStatement(locationId, s.body);
      setBusy(false);
      if (!out.ok) {
        setSubmitError({ message: out.message, problems: out.problems });
        return;
      }
      const fin = await finishBatch(locationId, batchId, { rowCount: s.total, accepted: out.lineCount, rejected: s.total - out.lineCount, errors: [] });
      setDone({ ...IDLE_DONE, statement: { id: out.statementId, lineCount: out.lineCount }, finishError: fin.error?.error ?? null });
      setStep('done');
      onFinished();
      return;
    }
    setStep('done');
    setDone({ ...IDLE_DONE, running: true, total: s.items.length, skipped: s.rejected.length });
    const outcomes = await submitRows(locationId, batchId, s.items, (n) => setDone((d) => ({ ...d, done: n })), () => false);
    const failed = outcomes.filter((o) => o.status === 'failed');
    const errors: BatchError[] = [...s.rejected, ...failed.map((f) => ({ row: f.sourceRow ?? f.index + 1, message: f.message ?? 'Refused' }))];
    const fin = await finishBatch(locationId, batchId, {
      rowCount: s.total,
      accepted: outcomes.length - failed.length,
      rejected: failed.length + s.rejected.length,
      errors,
    });
    setDone({ running: false, done: outcomes.length, total: s.items.length, outcomes, skipped: s.rejected.length, statement: null, statementError: null, finishError: fin.error?.error ?? null });
    onFinished();
  }

  async function cancel() {
    if (locationId && batchId && step !== 'done') await abandonBatch(locationId, batchId);
    setConfirmCancel(false);
    onFinished();
    onClose();
  }

  const stepIndex = STEPS.findIndex((s) => s.key === step);

  return (
    <section className="card mb-6 overflow-hidden" aria-label="Import a file">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 px-5 py-4">
        <div className="min-w-0">
          <h2 className="text-heading text-white">Import a file{kind ? ` — ${FILE_KIND[kind].label}` : ''}</h2>
          <ol className="mt-2 flex flex-wrap items-center gap-1 text-2xs" aria-label="Progress">
            {STEPS.map((s, i) => (
              <li key={s.key} className="flex items-center gap-1">
                <span
                  aria-current={i === stepIndex ? 'step' : undefined}
                  className={clsx(
                    'inline-flex items-center gap-1 rounded-full px-2 py-0.5',
                    i < stepIndex ? 'bg-emerald-500/10 text-emerald-300' : i === stepIndex ? 'bg-slate-700 text-white' : 'text-slate-500',
                  )}
                >
                  {i < stepIndex && <Check size={10} />}
                  {s.label}
                </span>
                {i < STEPS.length - 1 && <span className="text-slate-700">›</span>}
              </li>
            ))}
          </ol>
        </div>
        <button
          type="button"
          className="btn-ghost btn-sm inline-flex items-center gap-1.5"
          onClick={() => (batchId && step !== 'done' ? setConfirmCancel(true) : onClose())}
          disabled={done.running}
        >
          <X size={13} /> {step === 'done' ? 'Close' : 'Cancel'}
        </button>
      </header>

      <div className="px-5 py-5">
        {step === 'choose' && (
          <>
            <StepChoose setup={setup} onChange={setSetup} dmsSystem={pack.settings?.dms_system ?? null} />
            <div className="mt-6 flex items-center justify-end gap-3">
              {problems.length > 0 && kind && <span className="text-xs text-slate-500">{problems[0]}</span>}
              <button type="button" className="btn-primary btn-sm" disabled={problems.length > 0} onClick={() => setStep('upload')}>
                Continue
              </button>
            </div>
          </>
        )}

        {step === 'upload' && kind && (
          <>
            {paused && <AiPausedNotice message={paused.message} onRetry={() => setPaused(null)} />}
            {uploadError && <ErrorPanel error={uploadError} compact />}
            <StepUpload kind={kind} busy={busy} onSubmit={(i) => void onUpload(i)} />
            <div className="mt-4">
              <button type="button" className="btn-ghost btn-sm" onClick={() => setStep('choose')} disabled={busy}>Back</button>
            </div>
          </>
        )}

        {step === 'map' && kind && parse && (
          <StepMap
            kind={kind}
            parse={parse}
            mapping={mapping}
            onMapping={setMapping}
            ctx={ctx}
            profileNote={profileNote}
            saveProfile={saveProfile}
            onSaveProfile={setSaveProfile}
            checking={resolution.loading}
            onBack={() => setStep('upload')}
            onContinue={mapToReview}
          />
        )}

        {step === 'review' && kind && (
          <>
            {submitError && (
              <div role="alert" className="mb-4 rounded-lg border border-red-500/30 bg-red-500/[0.06] p-4 text-sm text-red-100">
                <p className="font-medium">{submitError.message}</p>
                {submitError.problems.length > 0 && (
                  <ul className="mt-2 list-disc pl-5 text-red-200/90">
                    {submitError.problems.map((p) => <li key={p}>{p}</li>)}
                  </ul>
                )}
              </div>
            )}
            {ai?.autonomyReason && !ai.autoImported && isStatementKind(kind) && (
              <Notice tone="info">Not imported automatically: {ai.autonomyReason}</Notice>
            )}
            <StepReview
              kind={kind}
              source={ai ? 'ai' : 'mapping'}
              rows={rows}
              onRows={setRows}
              header={header}
              onHeader={setHeader}
              ctx={ctx}
              documentId={documentId}
              aiMeta={ai ? { confidence: ai.proposal.confidence, documentNote: ai.proposal.documentNote, model: ai.model } : null}
              checking={resolution.loading}
              resolveError={resolution.error}
              onRecheck={resolution.recheck}
              busy={busy}
              onBack={() => setStep(parse ? 'map' : 'upload')}
              onSubmit={(s) => void onSubmit(s)}
            />
          </>
        )}

        {step === 'done' && kind && batchId && <StepDone kind={kind} batchId={batchId} state={done} onAnother={reset} />}
      </div>

      <ConfirmDialog
        open={confirmCancel}
        onClose={() => setConfirmCancel(false)}
        onConfirm={() => void cancel()}
        title="Cancel this import?"
        body="Nothing has been imported yet. The uploaded file stays on record with the cancelled import."
        confirmLabel="Cancel import"
        danger
      />
    </section>
  );
}
