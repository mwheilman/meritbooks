'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import clsx from 'clsx';
import {
  Layers,
  Plus,
  Trash2,
  Loader2,
  AlertTriangle,
  CheckCircle2,
  ShieldAlert,
  Pencil,
  X,
  FileText,
  Receipt,
  CircleDollarSign,
  Percent,
  Zap,
} from 'lucide-react';

// Client workspace for a job's Schedule of Values. Handles:
//   - create a DRAFT version (empty or seeded from another version)
//   - edit a DRAFT version's lines / memo / % complete, Save (PATCH)
//   - activate a DRAFT version (POST activate; supersedes the prior active)
//   - generate a progress bill from the ACTIVE version (POST generate) and show
//     the created draft's net + retainage, with a link to /billing to issue it.
// DRAFT versions are editable; ACTIVE/SUPERSEDED are read-only (revise by making a
// new version). All money is bigint cents; percents are edited as 0-100 and sent
// as 0..1 fractions.

// ---- Public DTOs (shared with the server page) -------------------------------

export interface ContractDto {
  originalContractCents: number;
  retentionPct: number; // 0..1
  status: string;
}

export interface SovVersionDto {
  id: string;
  version: number;
  status: 'DRAFT' | 'ACTIVE' | 'SUPERSEDED';
  memo: string | null;
  lineCount: number;
  scheduledTotalCents: number;
  earnedToDateCents: number;
  remainingCents: number;
  pctCompleteWeighted: number; // 0..1
}

export interface SovLineDto {
  id: string;
  lineNo: number;
  description: string;
  scheduledValueCents: number;
  pctComplete: number; // 0..1
  retainagePct: number | null; // 0..1 override, or null
  sortOrder: number;
}

interface JobDto {
  id: string;
  jobNumber: string;
  name: string;
  customerName: string | null;
}

// ---- Money / percent helpers -------------------------------------------------

const usd = (cents: number): string =>
  (cents / 100).toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });

const usdExact = (cents: number): string =>
  (cents / 100).toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

const fmtPct = (fraction: number): string => `${(fraction * 100).toFixed(1)}%`;

// dollars string -> integer cents (client-side; the server re-derives authoritatively)
function parseDollarsToCents(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const value = Number(trimmed);
  if (!Number.isFinite(value)) return null;
  return Math.round(value * 100);
}

// percent string (0-100) -> 0..1 fraction rounded to 4 dp (numeric(5,4))
function parsePercentToFraction(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const value = Number(trimmed);
  if (!Number.isFinite(value)) return null;
  return Math.round((value / 100) * 10000) / 10000;
}

const centsToDollarsStr = (cents: number): string => (cents / 100).toFixed(2);
const fractionToPercentStr = (f: number): string => {
  const p = f * 100;
  return Number.isInteger(p) ? String(p) : String(Number(p.toFixed(2)));
};

const todayIso = (): string => new Date().toISOString().slice(0, 10);

function extractError(payload: unknown): string | null {
  if (payload && typeof payload === 'object' && 'error' in payload) {
    const value = (payload as { error?: unknown }).error;
    if (typeof value === 'string') return value;
  }
  return null;
}

// ---- Edit-row model ----------------------------------------------------------

interface EditLine {
  key: string;
  description: string;
  scheduled: string; // dollars
  pct: string; // percent 0-100
  retainage: string; // percent 0-100, '' = use contract rate
}

let keySeq = 0;
const nextKey = (): string => `l${keySeq++}_${Math.random().toString(36).slice(2, 7)}`;

function blankLine(): EditLine {
  return { key: nextKey(), description: '', scheduled: '', pct: '0', retainage: '' };
}

function lineToEdit(line: SovLineDto): EditLine {
  return {
    key: nextKey(),
    description: line.description,
    scheduled: centsToDollarsStr(line.scheduledValueCents),
    pct: fractionToPercentStr(line.pctComplete),
    retainage: line.retainagePct === null ? '' : fractionToPercentStr(line.retainagePct),
  };
}

interface LinePayload {
  lineNo: number;
  description: string;
  scheduledValueCents: number;
  pctComplete: number;
  retainagePct?: number;
  sortOrder: number;
}

// ---- Component ---------------------------------------------------------------

type Mode = 'view' | 'edit' | 'create';
type GenPhase = 'idle' | 'armed' | 'submitting' | 'done';
type GenResult = { netCents: number; retainageCents: number; grossCents: number } | null;

export function SovEditor({
  job,
  contract,
  versions,
  linesByVersion,
}: {
  job: JobDto;
  contract: ContractDto | null;
  versions: SovVersionDto[];
  linesByVersion: Record<string, SovLineDto[]>;
}) {
  const router = useRouter();

  const activeVersion = useMemo(() => versions.find((v) => v.status === 'ACTIVE') ?? null, [versions]);

  const [selectedId, setSelectedId] = useState<string | null>(
    () => activeVersion?.id ?? versions[0]?.id ?? null,
  );
  const [mode, setMode] = useState<Mode>(versions.length === 0 ? 'create' : 'view');

  const [memo, setMemo] = useState('');
  const [editLines, setEditLines] = useState<EditLine[]>([blankLine()]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedVersion = useMemo(
    () => versions.find((v) => v.id === selectedId) ?? null,
    [versions, selectedId],
  );
  const selectedLines = selectedId ? linesByVersion[selectedId] ?? [] : [];

  const contractCents = contract?.originalContractCents ?? 0;
  const retentionPct = contract?.retentionPct ?? 0;

  // ---- edit-line mutations ---------------------------------------------------

  const startCreate = useCallback(
    (seedFrom?: SovVersionDto) => {
      const seedLines = seedFrom ? linesByVersion[seedFrom.id] ?? [] : [];
      setEditLines(seedLines.length ? seedLines.map(lineToEdit) : [blankLine()]);
      setMemo('');
      setError(null);
      setMode('create');
    },
    [linesByVersion],
  );

  const startEdit = useCallback(
    (version: SovVersionDto) => {
      const lines = linesByVersion[version.id] ?? [];
      setEditLines(lines.length ? lines.map(lineToEdit) : [blankLine()]);
      setMemo(version.memo ?? '');
      setError(null);
      setSelectedId(version.id);
      setMode('edit');
    },
    [linesByVersion],
  );

  const cancelEdit = useCallback(() => {
    setError(null);
    setMode(versions.length === 0 ? 'create' : 'view');
  }, [versions.length]);

  const updateLine = (key: string, patch: Partial<EditLine>) =>
    setEditLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  const removeLine = (key: string) =>
    setEditLines((prev) => (prev.length > 1 ? prev.filter((l) => l.key !== key) : prev));

  const addLine = () => setEditLines((prev) => [...prev, blankLine()]);

  // ---- live totals for the editor -------------------------------------------

  const editTotals = useMemo(() => {
    let scheduled = 0;
    let earned = 0;
    for (const l of editLines) {
      const cents = parseDollarsToCents(l.scheduled);
      const frac = parsePercentToFraction(l.pct);
      if (cents && cents > 0) {
        scheduled += cents;
        if (frac !== null) earned += Math.round(cents * frac);
      }
    }
    return { scheduled, earned, weighted: scheduled > 0 ? earned / scheduled : 0 };
  }, [editLines]);

  // ---- validation ------------------------------------------------------------

  const validation = useMemo((): string | null => {
    if (editLines.length === 0) return 'Add at least one line.';
    for (const l of editLines) {
      if (!l.description.trim()) return 'Every line needs a description.';
      const cents = parseDollarsToCents(l.scheduled);
      if (cents === null) return 'Every line needs a scheduled value.';
      if (cents < 0) return 'Scheduled values cannot be negative.';
      const frac = parsePercentToFraction(l.pct === '' ? '0' : l.pct);
      if (frac === null || frac < 0 || frac > 1) return 'Percent complete must be between 0 and 100.';
      if (l.retainage.trim() !== '') {
        const r = parsePercentToFraction(l.retainage);
        if (r === null || r < 0 || r > 1) return 'Retainage % must be between 0 and 100.';
      }
    }
    if (editTotals.scheduled <= 0) return 'The schedule total must be greater than 0.';
    return null;
  }, [editLines, editTotals.scheduled]);

  const buildPayload = useCallback((): LinePayload[] => {
    return editLines.map((l, index) => {
      const cents = parseDollarsToCents(l.scheduled) ?? 0;
      const frac = parsePercentToFraction(l.pct === '' ? '0' : l.pct) ?? 0;
      const rTrim = l.retainage.trim();
      const r = rTrim === '' ? undefined : parsePercentToFraction(rTrim) ?? undefined;
      return {
        lineNo: index + 1,
        description: l.description.trim(),
        scheduledValueCents: cents,
        pctComplete: frac,
        ...(r !== undefined ? { retainagePct: r } : {}),
        sortOrder: index,
      };
    });
  }, [editLines]);

  // ---- submit: create / save -------------------------------------------------

  const submitCreate = async () => {
    if (validation) {
      setError(validation);
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch('/api/billing/sov', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jobId: job.id,
          memo: memo.trim() ? memo.trim() : undefined,
          lines: buildPayload(),
        }),
      });
      const payload: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        setError(extractError(payload) ?? `Failed to create schedule (${res.status}).`);
        setSubmitting(false);
        return;
      }
      const newId =
        payload && typeof payload === 'object' && 'id' in payload
          ? String((payload as { id: unknown }).id)
          : null;
      if (newId) setSelectedId(newId);
      setMode('view');
      setSubmitting(false);
      router.refresh();
    } catch {
      setError('Network error — the schedule was not created.');
      setSubmitting(false);
    }
  };

  const submitSave = async () => {
    if (!selectedId) return;
    if (validation) {
      setError(validation);
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/billing/sov/${selectedId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          memo: memo.trim() ? memo.trim() : null,
          lines: buildPayload(),
        }),
      });
      const payload: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        setError(extractError(payload) ?? `Failed to save schedule (${res.status}).`);
        setSubmitting(false);
        return;
      }
      setMode('view');
      setSubmitting(false);
      router.refresh();
    } catch {
      setError('Network error — changes were not saved.');
      setSubmitting(false);
    }
  };

  // ---- activate --------------------------------------------------------------

  const [activating, setActivating] = useState(false);
  const [activateError, setActivateError] = useState<string | null>(null);

  const activate = async (versionId: string) => {
    setActivating(true);
    setActivateError(null);
    try {
      const res = await fetch(`/api/billing/sov/${versionId}/activate`, { method: 'POST' });
      const payload: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        setActivateError(extractError(payload) ?? `Activation failed (${res.status}).`);
        setActivating(false);
        return;
      }
      setActivating(false);
      router.refresh();
    } catch {
      setActivateError('Network error — nothing was activated.');
      setActivating(false);
    }
  };

  // ---- generate progress bill (two-step confirm) -----------------------------

  const [genOccurredOn, setGenOccurredOn] = useState(todayIso());
  const [genPhase, setGenPhase] = useState<GenPhase>('idle');
  const [genResult, setGenResult] = useState<GenResult>(null);
  const [genError, setGenError] = useState<string | null>(null);
  const disarmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (disarmTimer.current) clearTimeout(disarmTimer.current);
    },
    [],
  );

  const armGenerate = () => {
    setGenError(null);
    setGenResult(null);
    setGenPhase('armed');
    if (disarmTimer.current) clearTimeout(disarmTimer.current);
    disarmTimer.current = setTimeout(() => setGenPhase('idle'), 6000);
  };

  const fireGenerate = async () => {
    if (disarmTimer.current) clearTimeout(disarmTimer.current);
    setGenPhase('submitting');
    setGenError(null);
    try {
      const res = await fetch('/api/billing/sov/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId: job.id, occurredOn: genOccurredOn }),
      });
      const payload: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        setGenError(extractError(payload) ?? `Progress billing failed (${res.status}).`);
        setGenPhase('idle');
        return;
      }
      const p = payload as { netCents?: number; retainageCents?: number; grossCents?: number } | null;
      setGenResult({
        netCents: Number(p?.netCents ?? 0),
        retainageCents: Number(p?.retainageCents ?? 0),
        grossCents: Number(p?.grossCents ?? 0),
      });
      setGenPhase('done');
      router.refresh();
    } catch {
      setGenError('Network error — no progress bill was created.');
      setGenPhase('idle');
    }
  };

  const editing = mode === 'edit' || mode === 'create';

  // ---------------------------------------------------------------------------
  return (
    <div className="space-y-6">
      {/* Header */}
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="flex items-center gap-2 text-title text-white">
            <Layers className="h-6 w-6 text-brand-400" />
            Schedule of Values
          </h1>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm text-slate-400">
            <span className="num text-2xs text-slate-500">{job.jobNumber}</span>
            <span className="font-medium text-white">{job.name}</span>
            {job.customerName && <span className="text-slate-500">· {job.customerName}</span>}
          </div>
        </div>
        <div className="flex items-center gap-3">
          <MiniStat label="Contract value" value={contract ? usd(contractCents) : '—'} />
          <MiniStat label="Retention" value={contract ? fmtPct(retentionPct) : '—'} icon={<Percent className="h-3.5 w-3.5" />} />
        </div>
      </header>

      {!contract && (
        <div className="flex items-start gap-2 rounded-lg border border-warning/40 bg-surface-900 p-3">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning-fg" />
          <p className="text-sm text-slate-300">
            No contract is on file for this job yet. You can still build a schedule of values, but
            retainage will withhold at 0% until a contract retention rate is set.
          </p>
        </div>
      )}

      {/* Version strip */}
      {versions.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-2xs uppercase tracking-wider text-slate-500">Versions</span>
          {versions.map((v) => (
            <button
              key={v.id}
              type="button"
              disabled={editing}
              onClick={() => {
                setSelectedId(v.id);
                setMode('view');
              }}
              className={clsx(
                'inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-2xs font-medium transition-colors',
                editing && 'cursor-not-allowed opacity-50',
                v.id === selectedId
                  ? 'border-brand-500/50 bg-brand-500/10 text-brand-300'
                  : 'border-surface-800 text-slate-300 hover:bg-surface-850',
              )}
            >
              <span className="num">v{v.version}</span>
              <StatusDot status={v.status} />
            </button>
          ))}
          {!editing && (
            <button
              type="button"
              onClick={() => startCreate(selectedVersion ?? undefined)}
              className="inline-flex items-center gap-1 rounded-lg border border-surface-800 px-2.5 py-1 text-2xs font-medium text-slate-300 hover:bg-surface-850"
            >
              <Plus className="h-3.5 w-3.5" />
              New version
            </button>
          )}
        </div>
      )}

      {/* Body */}
      {editing ? (
        <EditorCard
          mode={mode}
          memo={memo}
          setMemo={setMemo}
          lines={editLines}
          contractRetentionPct={retentionPct}
          onUpdateLine={updateLine}
          onRemoveLine={removeLine}
          onAddLine={addLine}
          totals={editTotals}
          error={error}
          submitting={submitting}
          validationBlocked={validation !== null}
          onCancel={cancelEdit}
          onSubmit={mode === 'create' ? submitCreate : submitSave}
        />
      ) : versions.length === 0 ? (
        <EmptyState onCreate={() => startCreate()} />
      ) : selectedVersion ? (
        <ViewCard
          version={selectedVersion}
          lines={selectedLines}
          contractRetentionPct={retentionPct}
          onEdit={() => startEdit(selectedVersion)}
          onActivate={() => activate(selectedVersion.id)}
          activating={activating}
          activateError={activateError}
        />
      ) : null}

      {/* Generate progress bill — available whenever a version is ACTIVE */}
      {!editing && activeVersion && (
        <GeneratePanel
          activeVersion={activeVersion}
          occurredOn={genOccurredOn}
          setOccurredOn={setGenOccurredOn}
          phase={genPhase}
          result={genResult}
          error={genError}
          onArm={armGenerate}
          onFire={fireGenerate}
          onDisarm={() => setGenPhase('idle')}
          onReset={() => {
            setGenPhase('idle');
            setGenResult(null);
          }}
        />
      )}
    </div>
  );
}

// ---- Sub-components ----------------------------------------------------------

function MiniStat({ label, value, icon }: { label: string; value: string; icon?: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-surface-800 bg-surface-900 px-4 py-2">
      <div className="flex items-center gap-1.5 text-2xs uppercase tracking-wider text-slate-500">
        {icon}
        {label}
      </div>
      <div className="num mt-0.5 text-heading font-semibold text-white">{value}</div>
    </div>
  );
}

function StatusDot({ status }: { status: SovVersionDto['status'] }) {
  const meta =
    status === 'ACTIVE'
      ? { dot: 'bg-success-fg', text: 'text-success-fg', label: 'Active' }
      : status === 'DRAFT'
        ? { dot: 'bg-slate-500', text: 'text-slate-300', label: 'Draft' }
        : { dot: 'bg-slate-600', text: 'text-slate-500', label: 'Superseded' };
  return (
    <span className={clsx('inline-flex items-center gap-1', meta.text)}>
      <span className={clsx('h-1.5 w-1.5 rounded-full', meta.dot)} />
      {meta.label}
    </span>
  );
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="rounded-xl border border-surface-800 bg-surface-900 p-12 text-center">
      <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-lg border border-surface-800 bg-surface-950">
        <Layers className="h-6 w-6 text-slate-500" />
      </div>
      <div className="mt-4 text-heading text-white">No schedule of values yet</div>
      <p className="mx-auto mt-1 max-w-md text-sm text-slate-400">
        Build a schedule of values to bill this job by percent complete. Each line carries a
        scheduled value; you set % complete per period and generate an AIA-style progress bill.
      </p>
      <button
        type="button"
        onClick={onCreate}
        className="mt-5 inline-flex items-center gap-2 rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-surface-950 hover:bg-brand-400"
      >
        <Plus className="h-4 w-4" />
        Create schedule of values
      </button>
    </div>
  );
}

function ViewCard({
  version,
  lines,
  contractRetentionPct,
  onEdit,
  onActivate,
  activating,
  activateError,
}: {
  version: SovVersionDto;
  lines: SovLineDto[];
  contractRetentionPct: number;
  onEdit: () => void;
  onActivate: () => void;
  activating: boolean;
  activateError: string | null;
}) {
  const isDraft = version.status === 'DRAFT';
  return (
    <section className="overflow-hidden rounded-xl border border-surface-800 bg-surface-900">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-surface-800 px-5 py-3">
        <div className="flex items-center gap-3">
          <div className="text-heading text-white">
            Version <span className="num">{version.version}</span>
          </div>
          <StatusDot status={version.status} />
          <span className="text-2xs text-slate-500">
            {version.lineCount} line{version.lineCount === 1 ? '' : 's'}
          </span>
        </div>
        {isDraft && (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onEdit}
              className="inline-flex items-center gap-1.5 rounded-lg border border-surface-800 px-3 py-1.5 text-2xs font-medium text-slate-300 hover:bg-surface-850"
            >
              <Pencil className="h-3.5 w-3.5" />
              Edit
            </button>
            <button
              type="button"
              onClick={onActivate}
              disabled={activating}
              className={clsx(
                'inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-2xs font-medium transition-colors',
                activating
                  ? 'cursor-not-allowed bg-surface-800 text-slate-500'
                  : 'bg-brand-500 text-surface-950 hover:bg-brand-400',
              )}
              title="Make this the active schedule and supersede any prior active version"
            >
              {activating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Zap className="h-3.5 w-3.5" />}
              {activating ? 'Activating…' : 'Activate'}
            </button>
          </div>
        )}
      </div>

      {version.memo && (
        <div className="border-b border-surface-800 px-5 py-2.5 text-sm text-slate-400">{version.memo}</div>
      )}

      {activateError && (
        <div className="flex items-start gap-2 border-b border-surface-800 bg-danger/10 px-5 py-2.5">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-danger-fg" />
          <span className="text-sm text-danger-fg">{activateError}</span>
        </div>
      )}

      {lines.length === 0 ? (
        <div className="px-5 py-12 text-center text-sm text-slate-500">This version has no lines.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-surface-800 text-left text-2xs uppercase tracking-wider text-slate-500">
                <th className="px-5 py-2.5 font-medium">#</th>
                <th className="px-5 py-2.5 font-medium">Description</th>
                <th className="px-5 py-2.5 text-right font-medium">Scheduled value</th>
                <th className="px-5 py-2.5 text-right font-medium">% complete</th>
                <th className="px-5 py-2.5 text-right font-medium">Earned to date</th>
                <th className="px-5 py-2.5 text-right font-medium">Retainage</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => {
                const earned = Math.round(l.scheduledValueCents * l.pctComplete);
                const effRet = l.retainagePct ?? contractRetentionPct;
                return (
                  <tr key={l.id} className="border-b border-surface-800/60 last:border-0 hover:bg-surface-850/40">
                    <td className="num px-5 py-3 text-slate-500">{l.lineNo}</td>
                    <td className="px-5 py-3 text-white">{l.description}</td>
                    <td className="num px-5 py-3 text-right text-slate-300">{usdExact(l.scheduledValueCents)}</td>
                    <td className="num px-5 py-3 text-right text-slate-300">{fmtPct(l.pctComplete)}</td>
                    <td className="num px-5 py-3 text-right font-medium text-white">{usdExact(earned)}</td>
                    <td className="num px-5 py-3 text-right text-slate-400">
                      {fmtPct(effRet)}
                      {l.retainagePct !== null && (
                        <span className="ml-1 text-2xs text-brand-400" title="Per-line override">
                          ✎
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="border-t border-surface-800 bg-surface-950/40 text-sm">
                <td className="px-5 py-3" />
                <td className="px-5 py-3 text-2xs uppercase tracking-wider text-slate-500">Totals</td>
                <td className="num px-5 py-3 text-right font-semibold text-white">
                  {usdExact(version.scheduledTotalCents)}
                </td>
                <td className="num px-5 py-3 text-right font-semibold text-brand-400">
                  {fmtPct(version.pctCompleteWeighted)}
                </td>
                <td className="num px-5 py-3 text-right font-semibold text-white">
                  {usdExact(version.earnedToDateCents)}
                </td>
                <td className="px-5 py-3" />
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </section>
  );
}

function EditorCard({
  mode,
  memo,
  setMemo,
  lines,
  contractRetentionPct,
  onUpdateLine,
  onRemoveLine,
  onAddLine,
  totals,
  error,
  submitting,
  validationBlocked,
  onCancel,
  onSubmit,
}: {
  mode: Mode;
  memo: string;
  setMemo: (v: string) => void;
  lines: EditLine[];
  contractRetentionPct: number;
  onUpdateLine: (key: string, patch: Partial<EditLine>) => void;
  onRemoveLine: (key: string) => void;
  onAddLine: () => void;
  totals: { scheduled: number; earned: number; weighted: number };
  error: string | null;
  submitting: boolean;
  validationBlocked: boolean;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  return (
    <section className="rounded-xl border border-surface-800 bg-surface-900 p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-heading text-white">
            {mode === 'create' ? 'New schedule of values' : 'Edit schedule of values'}
          </div>
          <p className="mt-0.5 text-2xs text-slate-500">
            {mode === 'create'
              ? 'Creates a DRAFT version. Activate it to bill against it.'
              : 'DRAFT only. Save updates the scheduled values and % complete.'}
          </p>
        </div>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md p-1 text-slate-500 hover:bg-surface-850 hover:text-slate-300"
          aria-label="Cancel"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <label className="mt-4 block">
        <span className="mb-1.5 block text-2xs uppercase tracking-wider text-slate-500">
          Memo <span className="text-slate-600">(optional)</span>
        </span>
        <input
          type="text"
          value={memo}
          onChange={(e) => setMemo(e.target.value)}
          maxLength={1000}
          placeholder="e.g. Rev 2 — added change order #4"
          className="w-full rounded-lg border border-surface-800 bg-surface-950 px-3 py-2 text-sm text-white placeholder:text-slate-600 focus:border-brand-500/50 focus:outline-none"
        />
      </label>

      {/* Line rows */}
      <div className="mt-5">
        <div className="mb-2 hidden items-center gap-2 px-1 text-2xs uppercase tracking-wider text-slate-500 sm:flex">
          <span className="flex-1">Description</span>
          <span className="w-36 text-right">Scheduled value</span>
          <span className="w-24 text-right">% complete</span>
          <span className="w-28 text-right">Retainage %</span>
          <span className="w-9" />
        </div>
        <div className="space-y-2">
          {lines.map((line) => {
            const cents = parseDollarsToCents(line.scheduled);
            const frac = parsePercentToFraction(line.pct === '' ? '0' : line.pct);
            const badCents = cents !== null && cents < 0;
            const badPct = frac !== null && (frac < 0 || frac > 1);
            return (
              <div key={line.key} className="flex flex-wrap items-center gap-2 sm:flex-nowrap">
                <input
                  type="text"
                  value={line.description}
                  onChange={(e) => onUpdateLine(line.key, { description: e.target.value })}
                  placeholder="Description"
                  maxLength={500}
                  className="min-w-0 flex-1 rounded-lg border border-surface-800 bg-surface-950 px-3 py-2 text-sm text-white placeholder:text-slate-600 focus:border-brand-500/50 focus:outline-none"
                />
                <div className="relative w-36">
                  <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-slate-500">$</span>
                  <input
                    type="number"
                    inputMode="decimal"
                    min="0"
                    step="0.01"
                    value={line.scheduled}
                    onChange={(e) => onUpdateLine(line.key, { scheduled: e.target.value })}
                    placeholder="0.00"
                    className={clsx(
                      'num w-full rounded-lg border bg-surface-950 py-2 pl-6 pr-3 text-right text-sm text-white placeholder:text-slate-600 focus:outline-none',
                      badCents ? 'border-danger/50' : 'border-surface-800 focus:border-brand-500/50',
                    )}
                  />
                </div>
                <div className="relative w-24">
                  <input
                    type="number"
                    inputMode="decimal"
                    min="0"
                    max="100"
                    step="0.1"
                    value={line.pct}
                    onChange={(e) => onUpdateLine(line.key, { pct: e.target.value })}
                    placeholder="0"
                    className={clsx(
                      'num w-full rounded-lg border bg-surface-950 py-2 pl-3 pr-6 text-right text-sm text-white placeholder:text-slate-600 focus:outline-none',
                      badPct ? 'border-danger/50' : 'border-surface-800 focus:border-brand-500/50',
                    )}
                  />
                  <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-slate-500">%</span>
                </div>
                <div className="relative w-28">
                  <input
                    type="number"
                    inputMode="decimal"
                    min="0"
                    max="100"
                    step="0.1"
                    value={line.retainage}
                    onChange={(e) => onUpdateLine(line.key, { retainage: e.target.value })}
                    placeholder={fractionToPercentStr(contractRetentionPct)}
                    title="Optional per-line retainage override; blank uses the contract rate"
                    className="num w-full rounded-lg border border-surface-800 bg-surface-950 py-2 pl-3 pr-6 text-right text-sm text-white placeholder:text-slate-600 focus:border-brand-500/50 focus:outline-none"
                  />
                  <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-slate-500">%</span>
                </div>
                <button
                  type="button"
                  onClick={() => onRemoveLine(line.key)}
                  disabled={lines.length === 1}
                  className={clsx(
                    'rounded-md p-2 transition-colors',
                    lines.length === 1
                      ? 'cursor-not-allowed text-slate-700'
                      : 'text-slate-500 hover:bg-danger/10 hover:text-danger-fg',
                  )}
                  aria-label="Remove line"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            );
          })}
        </div>

        <button
          type="button"
          onClick={onAddLine}
          className="mt-3 inline-flex items-center gap-1 text-2xs font-medium text-brand-300 hover:text-brand-200"
        >
          <Plus className="h-3.5 w-3.5" />
          Add line
        </button>
      </div>

      {/* Live totals */}
      <div className="mt-4 grid grid-cols-3 gap-3 border-t border-surface-800 pt-4">
        <FooterFig label="Scheduled total" value={usdExact(totals.scheduled)} />
        <FooterFig label="Earned to date" value={usdExact(totals.earned)} />
        <FooterFig label="Weighted % complete" value={fmtPct(totals.weighted)} tone="brand" />
      </div>

      {error && (
        <div className="mt-4 flex items-start gap-2 rounded-lg border border-danger/40 bg-danger/10 p-3">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-danger-fg" />
          <span className="text-sm text-danger-fg">{error}</span>
        </div>
      )}

      <div className="mt-5 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-lg border border-surface-800 px-3.5 py-2 text-sm font-medium text-slate-300 hover:bg-surface-850"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onSubmit}
          disabled={submitting || validationBlocked}
          className={clsx(
            'inline-flex items-center gap-2 rounded-lg px-3.5 py-2 text-sm font-medium transition-colors',
            submitting || validationBlocked
              ? 'cursor-not-allowed bg-surface-800 text-slate-500'
              : 'bg-brand-500 text-surface-950 hover:bg-brand-400',
          )}
        >
          {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
          {submitting ? 'Saving…' : mode === 'create' ? 'Create draft' : 'Save changes'}
        </button>
      </div>
    </section>
  );
}

function FooterFig({ label, value, tone }: { label: string; value: string; tone?: 'brand' }) {
  return (
    <div className="rounded-lg border border-surface-800 bg-surface-950 p-3">
      <div className="text-2xs uppercase tracking-wider text-slate-500">{label}</div>
      <div className={clsx('num mt-1 text-heading font-semibold', tone === 'brand' ? 'text-brand-400' : 'text-white')}>
        {value}
      </div>
    </div>
  );
}

function GeneratePanel({
  activeVersion,
  occurredOn,
  setOccurredOn,
  phase,
  result,
  error,
  onArm,
  onFire,
  onDisarm,
  onReset,
}: {
  activeVersion: SovVersionDto;
  occurredOn: string;
  setOccurredOn: (v: string) => void;
  phase: GenPhase;
  result: GenResult;
  error: string | null;
  onArm: () => void;
  onFire: () => void;
  onDisarm: () => void;
  onReset: () => void;
}) {
  return (
    <section className="rounded-xl border border-brand-500/30 bg-surface-900 p-5">
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-brand-500/30 bg-brand-500/10">
          <Receipt className="h-4 w-4 text-brand-400" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-heading text-white">Generate progress bill</div>
          <p className="mt-0.5 text-2xs text-slate-500">
            Bills the incremental earned amount on active version <span className="num">v{activeVersion.version}</span>{' '}
            since the last application, less retainage. Creates a DRAFT — issue it from Billing to emit the JOB_BILLING event.
          </p>

          {phase === 'done' && result ? (
            <div className="mt-4 rounded-lg border border-success/40 bg-success/10 p-4">
              <div className="flex items-center gap-2 text-sm font-medium text-success-fg">
                <CheckCircle2 className="h-4 w-4" />
                Draft progress bill created
              </div>
              <div className="mt-3 grid grid-cols-3 gap-3">
                <ResultFig label="Earned this app" value={usdExact(result.grossCents)} />
                <ResultFig label="Retainage withheld" value={`(${usdExact(result.retainageCents)})`} tone="warn" />
                <ResultFig label="Net billed" value={usdExact(result.netCents)} tone="brand" />
              </div>
              <div className="mt-4 flex items-center gap-3">
                <Link
                  href="/billing"
                  className="inline-flex items-center gap-1.5 rounded-lg bg-brand-500 px-3.5 py-2 text-sm font-medium text-surface-950 hover:bg-brand-400"
                >
                  <FileText className="h-4 w-4" />
                  Review & issue in Billing
                </Link>
                <button
                  type="button"
                  onClick={onReset}
                  className="text-2xs font-medium text-slate-400 hover:text-slate-200"
                >
                  Generate another
                </button>
              </div>
            </div>
          ) : (
            <div className="mt-4 flex flex-wrap items-end gap-3">
              <label className="block">
                <span className="mb-1.5 block text-2xs uppercase tracking-wider text-slate-500">Application date</span>
                <input
                  type="date"
                  value={occurredOn}
                  onChange={(e) => setOccurredOn(e.target.value)}
                  disabled={phase === 'submitting'}
                  className="num rounded-lg border border-surface-800 bg-surface-950 px-3 py-2 text-sm text-white focus:border-brand-500/50 focus:outline-none"
                />
              </label>

              {phase === 'submitting' ? (
                <span className="inline-flex items-center gap-1.5 rounded-lg border border-surface-800 px-3.5 py-2 text-sm font-medium text-slate-400">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Generating…
                </span>
              ) : phase === 'armed' ? (
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={onFire}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-warning/50 bg-warning/10 px-3.5 py-2 text-sm font-semibold text-warning-fg hover:bg-warning/20"
                  >
                    <ShieldAlert className="h-4 w-4" />
                    Confirm — generate bill
                  </button>
                  <button
                    type="button"
                    onClick={onDisarm}
                    className="rounded-lg border border-surface-800 px-3 py-2 text-sm font-medium text-slate-400 hover:bg-surface-850"
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={onArm}
                  className="inline-flex items-center gap-2 rounded-lg bg-brand-500 px-3.5 py-2 text-sm font-medium text-surface-950 hover:bg-brand-400"
                >
                  <CircleDollarSign className="h-4 w-4" />
                  Generate progress bill
                </button>
              )}
            </div>
          )}

          {error && (
            <div className="mt-4 flex items-start gap-2 rounded-lg border border-danger/40 bg-danger/10 p-3">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-danger-fg" />
              <span className="text-sm text-danger-fg">{error}</span>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function ResultFig({ label, value, tone }: { label: string; value: string; tone?: 'brand' | 'warn' }) {
  return (
    <div className="rounded-lg border border-surface-800 bg-surface-950 p-3">
      <div className="text-2xs uppercase tracking-wider text-slate-500">{label}</div>
      <div
        className={clsx(
          'num mt-1 text-sm font-semibold',
          tone === 'brand' ? 'text-brand-400' : tone === 'warn' ? 'text-warning-fg' : 'text-white',
        )}
      >
        {value}
      </div>
    </div>
  );
}
