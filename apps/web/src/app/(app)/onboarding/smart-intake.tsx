'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {
  UploadCloud, Loader2, Sparkles, FileText, FileSpreadsheet, ArrowRight, AlertTriangle, CheckCircle2,
  X, Wand2, FolderArchive, Info, Building2,
} from 'lucide-react';
import { clsx } from 'clsx';
import { useQuery } from '@/hooks';
import { useActiveCompany } from '@/lib/hooks/use-active-company';
import { isSpecificCompany } from '@/lib/company-scope';
import { uploadForParse } from '@/lib/uploads/client-upload';
import { isSheetName } from '@/lib/uploads/paths';
import { INTAKE_DOC_TYPES, INTAKE_ROUTES, type IntakeDocType, type ClassificationSource } from '@/lib/onboarding/intake/types';
import { handoffForFile, type IntakeHandoff } from '@/lib/onboarding/intake/handoff';
import { FormationIntake } from './formation-intake';
import { DebtParseReview } from '../debt/debt-parse-review';
import { BudgetImport } from '../budgets/budget-import';
import { ArReviewComponent } from '@/components/onboarding/sections/ar-review';
import { ApReviewComponent } from '@/components/onboarding/sections/ap-review';

/**
 * SMART INTAKE v2 — "drop everything, we put it to work" (FPB principle 5, slice W3).
 *
 * One drop zone, any number of files: corporate docs (articles, operating agreement,
 * EIN letter), loan agreements, the trial balance / general ledger, budget, customer
 * database / CRM export, vendor list, open A/R and A/P, WIP schedule, org chart,
 * expense policy … For each file:
 *   1. it is uploaded ONCE to storage (`uploadForParse`, org-scoped path);
 *   2. it is classified — AI when available, deterministic file-name + column rules
 *      when not (principle 10: never a dead end with AI off);
 *   3. a card shows what we think it is, how sure we are, and the ONE next action —
 *      and the user can correct the type from a dropdown;
 *   4. the action hands the SAME storage path to the receiver (FPB §5): formation
 *      review, loan review (existing-loan mode, B9), budget import, A/R / A/P review —
 *      in-page — or the Opening step (`/onboarding?step=opening&intake=…`). Anything
 *      without a parser yet (org chart, expense policy …) is saved to the company's
 *      documents with a plain note. The user never re-uploads.
 *
 * Canon: AI only proposes what a file is; every receiver shows a review, and only a
 * human confirmation writes anything.
 */

const MAX_BYTES = 15 * 1024 * 1024;
const CONCURRENCY = 3;

interface ClassifyResponse {
  ok: boolean;
  docType: IntakeDocType;
  confidence: number;
  source: ClassificationSource;
  note: string;
  storagePath: string | null;
  meta?: { ai?: 'used' | 'off' | 'failed' | 'skipped' };
  error?: string;
}

type ItemStatus = 'queued' | 'uploading' | 'classifying' | 'ready' | 'error';

interface IntakeItem {
  id: string;
  file: File;
  name: string;
  size: number;
  status: ItemStatus;
  storagePath: string | null;
  docType: IntakeDocType;
  confidence: number;
  source: ClassificationSource;
  note: string;
  ai: 'used' | 'off' | 'failed' | 'skipped' | null;
  error: string | null;
  /** Set once the item's next action has been completed. */
  done: string | null;
  busy: boolean;
}

interface LocationLite { id: string; name: string }

export interface SmartIntakeProps {
  /**
   * The company the files belong to. When omitted, the intake uses the header's active
   * company, else the org's first company (and offers a picker when there are several).
   */
  companyId?: string | null;
  /** B9: during onboarding, new loans default to "This loan already exists". Default true. */
  onboarding?: boolean;
  /** The cutover (as-of) date, when known — passed to the loan review. */
  cutoverDate?: string | null;
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function confidenceTone(c: number): string {
  if (c >= 0.75) return 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10';
  if (c >= 0.5) return 'text-amber-300 border-amber-500/30 bg-amber-500/10';
  return 'text-slate-400 border-slate-700 bg-slate-800/60';
}

function confidenceWords(c: number): string {
  if (c >= 0.85) return 'very likely';
  if (c >= 0.65) return 'likely';
  if (c >= 0.4) return 'best guess';
  return 'not sure';
}

export function SmartIntake({ companyId: companyIdProp, onboarding = true, cutoverDate = null }: SmartIntakeProps = {}) {
  const [items, setItems] = useState<IntakeItem[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [open, setOpen] = useState<{ id: string; kind: IntakeHandoff['kind'] } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const queueRef = useRef<string[]>([]);
  const runningRef = useRef(0);
  const itemsRef = useRef<IntakeItem[]>([]);
  itemsRef.current = items;

  // ── Company context ──────────────────────────────────────────────────────
  const { activeCompanyId } = useActiveCompany();
  const { data: locData, isLoading: locLoading } = useQuery<LocationLite[]>(
    companyIdProp === undefined ? '/api/locations' : null, undefined, { scope: false },
  );
  const locations = useMemo(() => (Array.isArray(locData) ? locData : []), [locData]);
  const [pickedCompany, setPickedCompany] = useState<string | null>(null);
  const companyId = useMemo<string | null>(() => {
    if (companyIdProp !== undefined) return companyIdProp;
    if (pickedCompany) return pickedCompany;
    if (isSpecificCompany(activeCompanyId) && locations.some((l) => l.id === activeCompanyId)) return activeCompanyId;
    return locations[0]?.id ?? null;
  }, [companyIdProp, pickedCompany, activeCompanyId, locations]);

  const patch = useCallback((id: string, p: Partial<IntakeItem>) => {
    setItems((xs) => xs.map((x) => (x.id === id ? { ...x, ...p } : x)));
  }, []);

  // ── Upload once + classify (bounded concurrency) ──────────────────────────
  const process = useCallback(async (id: string) => {
    const item = itemsRef.current.find((x) => x.id === id);
    if (!item) return;
    patch(id, { status: 'uploading', error: null });
    const up = await uploadForParse(item.file);
    if ('error' in up) { patch(id, { status: 'error', error: up.error }); return; }
    patch(id, { status: 'classifying', storagePath: up.storagePath });
    try {
      const res = await fetch('/api/onboarding/intake/classify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ storagePath: up.storagePath }),
      });
      const raw = await res.text();
      let body: ClassifyResponse | null = null;
      try { body = raw ? (JSON.parse(raw) as ClassifyResponse) : null; } catch { body = null; }
      if (!res.ok || !body?.ok) {
        // The file IS uploaded — never lose it: fall back to "not sure" so the user can pick.
        patch(id, {
          status: 'ready', docType: 'UNKNOWN', confidence: 0, source: 'rules',
          note: body?.error ?? 'We couldn’t tell what this is — pick a type below.', ai: null,
        });
        return;
      }
      patch(id, {
        status: 'ready',
        docType: body.docType,
        confidence: body.confidence,
        source: body.source,
        note: body.note,
        ai: body.meta?.ai ?? null,
      });
    } catch {
      patch(id, {
        status: 'ready', docType: 'UNKNOWN', confidence: 0, source: 'rules',
        note: 'We couldn’t reach the classifier — pick a type below.', ai: null,
      });
    }
  }, [patch]);

  const pump = useCallback(() => {
    while (runningRef.current < CONCURRENCY && queueRef.current.length > 0) {
      const next = queueRef.current.shift()!;
      runningRef.current += 1;
      void process(next).finally(() => {
        runningRef.current -= 1;
        pump();
      });
    }
  }, [process]);

  const addFiles = useCallback((files: FileList | File[]) => {
    const arr = Array.from(files);
    if (arr.length === 0) return;
    const fresh: IntakeItem[] = arr.map((f) => ({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      file: f,
      name: f.name,
      size: f.size,
      status: f.size > MAX_BYTES ? 'error' : 'queued',
      storagePath: null,
      docType: 'UNKNOWN',
      confidence: 0,
      source: 'rules',
      note: '',
      ai: null,
      error: f.size > MAX_BYTES ? 'Larger than 15MB — please split or compress it.' : f.size === 0 ? 'This file is empty.' : null,
      done: null,
      busy: false,
    }));
    for (const it of fresh) if (it.size === 0) it.status = 'error';
    itemsRef.current = [...itemsRef.current, ...fresh];
    setItems((xs) => [...xs, ...fresh]);
    queueRef.current.push(...fresh.filter((x) => x.status === 'queued').map((x) => x.id));
    pump();
  }, [pump]);

  const retry = useCallback((id: string) => {
    patch(id, { status: 'queued', error: null });
    queueRef.current.push(id);
    pump();
  }, [patch, pump]);

  const remove = useCallback((id: string) => {
    setItems((xs) => xs.filter((x) => x.id !== id));
    setOpen((o) => (o?.id === id ? null : o));
  }, []);

  const correctType = useCallback((id: string, docType: IntakeDocType) => {
    patch(id, { docType, source: 'user', confidence: 1, note: 'You chose this type.', done: null });
    setOpen((o) => (o?.id === id ? null : o));
  }, [patch]);

  const markDone = useCallback((id: string, text: string) => {
    patch(id, { done: text, busy: false });
    setOpen(null);
  }, [patch]);

  /** "file" handoff: record the already-uploaded object in the company's documents. */
  const fileIt = useCallback(async (item: IntakeItem) => {
    if (!item.storagePath) return;
    patch(item.id, { busy: true, error: null });
    try {
      const res = await fetch('/api/onboarding/intake/file', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          storagePath: item.storagePath,
          docType: item.docType,
          companyId,
          sizeBytes: item.size,
          mimeType: item.file.type || null,
        }),
      });
      const body = (await res.json().catch(() => null)) as { note?: string; error?: string } | null;
      if (!res.ok) { patch(item.id, { busy: false, error: body?.error ?? 'Could not save it — try again.' }); return; }
      markDone(item.id, body?.note ?? 'Saved to your documents.');
    } catch {
      patch(item.id, { busy: false, error: 'Network error — try again.' });
    }
  }, [companyId, patch, markDone]);

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer.files?.length) addFiles(e.dataTransfer.files);
  }

  const ready = items.filter((x) => x.status === 'ready');
  const working = items.filter((x) => x.status === 'queued' || x.status === 'uploading' || x.status === 'classifying').length;
  const doneCount = items.filter((x) => x.done).length;
  const aiOff = ready.some((x) => x.ai === 'off' || x.ai === 'failed');
  const openItem = open ? items.find((x) => x.id === open.id) ?? null : null;

  return (
    <div className="rounded-xl border border-indigo-500/25 bg-indigo-500/[0.04] p-4 space-y-3">
      <div className="flex items-start gap-2">
        <Sparkles size={15} className="text-indigo-400 mt-0.5" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-ink-hi">Drop everything you have</p>
          <p className="text-[11px] text-slate-500">
            Articles, operating agreement, EIN letter, loan agreements, trial balance or general ledger, budget, customer or
            CRM export, vendor list, WIP schedule, org chart, expense policy — we work out what each file is and put it to work.
          </p>
        </div>
        {companyIdProp === undefined && locations.length > 1 && (
          <label className="shrink-0 flex items-center gap-1.5 text-[11px] text-slate-400">
            <Building2 size={12} className="text-slate-500" />
            <span className="sr-only">Company</span>
            <select
              value={companyId ?? ''}
              onChange={(e) => setPickedCompany(e.target.value || null)}
              className="max-w-[180px] px-2 py-1 bg-slate-900 border border-slate-700 rounded-md text-[11px] text-ink-hi"
            >
              {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </label>
        )}
      </div>

      <div
        role="button"
        tabIndex={0}
        aria-label="Drop files here or press Enter to choose files"
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); inputRef.current?.click(); } }}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        onClick={() => inputRef.current?.click()}
        className={clsx(
          'flex flex-col items-center justify-center rounded-lg border-2 border-dashed px-6 py-8 text-center cursor-pointer transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/60',
          dragOver ? 'border-indigo-500 bg-indigo-500/10' : 'border-slate-700 hover:border-indigo-500/50',
        )}
      >
        <input
          ref={inputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => { if (e.target.files) addFiles(e.target.files); e.target.value = ''; }}
        />
        <UploadCloud size={26} className="text-slate-500 mb-2" />
        <p className="text-sm text-slate-200 font-medium">Drop files here — as many as you like</p>
        <p className="text-[11px] text-slate-500 mt-1">PDF, Excel (.xlsx), CSV, images, Word · up to 15MB each · nothing is saved to your books until you confirm it</p>
      </div>

      {items.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-400" aria-live="polite">
          <span>{items.length} file{items.length === 1 ? '' : 's'}</span>
          {working > 0 && <span className="inline-flex items-center gap-1"><Loader2 size={11} className="animate-spin text-indigo-400" /> sorting {working}…</span>}
          {doneCount > 0 && <span className="text-emerald-400">{doneCount} put to work</span>}
          {ready.length - doneCount > 0 && <span>{ready.length - doneCount} waiting for you</span>}
        </div>
      )}

      {aiOff && (
        <div className="flex items-start gap-2 rounded-lg border border-slate-700 bg-slate-900/60 px-3 py-2 text-[11px] text-slate-400" role="status">
          <Info size={13} className="mt-0.5 shrink-0 text-slate-500" />
          Sorted without AI — by file names and column headings. Check each guess and change it if it&rsquo;s wrong.
        </div>
      )}

      {companyIdProp === undefined && !locLoading && locations.length === 0 && items.length > 0 && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-200" role="alert">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" />
          Create your company first — budgets, customers and vendors are filed to a specific company. Your files are safe and will wait here.
        </div>
      )}

      {items.length > 0 && (
        <ul className="space-y-2">
          {items.map((it) => (
            <IntakeCard
              key={it.id}
              item={it}
              companyId={companyId}
              expanded={open?.id === it.id}
              onCorrect={(t) => correctType(it.id, t)}
              onRemove={() => remove(it.id)}
              onRetry={() => retry(it.id)}
              onOpen={(kind) => setOpen({ id: it.id, kind })}
              onClose={() => setOpen(null)}
              onFile={() => void fileIt(it)}
              onDone={(text) => markDone(it.id, text)}
            />
          ))}
        </ul>
      )}

      {/* Modal receivers (loan review, budget import) — the same file, no re-upload. */}
      {openItem && openItem.storagePath && open?.kind === 'debt' && (
        <DebtParseReview
          initialStoragePath={openItem.storagePath}
          existingDefault={onboarding ? true : undefined}
          cutoverDate={cutoverDate ?? undefined}
          onClose={() => setOpen(null)}
          onConfirmed={() => markDone(openItem.id, 'Loan set up with its payment schedule.')}
        />
      )}
      {openItem && openItem.storagePath && open?.kind === 'budget' && companyId && (
        <BudgetImport
          hideTrigger
          locationId={companyId}
          fiscalYear={new Date().getFullYear()}
          departmentId={null}
          initialStoragePath={openItem.storagePath}
          onImported={() => markDone(openItem.id, 'Budget loaded.')}
          onClosed={() => setOpen((o) => (o?.id === openItem.id && o.kind === 'budget' ? null : o))}
        />
      )}

      {items.length > 0 && (
        <p className="text-[10px] text-slate-600">
          Every file is uploaded once and kept. We suggest what it is; you confirm every record on the next step. A file we
          can&rsquo;t use yet is saved to your documents — never lost.
        </p>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// One file's card
// ─────────────────────────────────────────────────────────────────────────────

function IntakeCard({
  item, companyId, expanded, onCorrect, onRemove, onRetry, onOpen, onClose, onFile, onDone,
}: {
  item: IntakeItem;
  companyId: string | null;
  expanded: boolean;
  onCorrect: (t: IntakeDocType) => void;
  onRemove: () => void;
  onRetry: () => void;
  onOpen: (kind: IntakeHandoff['kind']) => void;
  onClose: () => void;
  onFile: () => void;
  onDone: (text: string) => void;
}) {
  const Icon = isSheetName(item.name) ? FileSpreadsheet : FileText;
  const handoff = item.status === 'ready' && item.storagePath ? handoffForFile(item.docType, item.storagePath, item.name) : null;
  const needsCompany = !!handoff && (handoff.kind === 'budget' || handoff.kind === 'ar' || handoff.kind === 'ap') && !companyId;
  const selectId = `intake-type-${item.id}`;

  return (
    <li className={clsx('rounded-lg border bg-surface-900', item.done ? 'border-emerald-500/30' : 'border-slate-800')}>
      <div className="flex flex-wrap items-center gap-3 px-3 py-2.5">
        <Icon size={15} className="shrink-0 text-slate-500" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs text-slate-200" title={item.name}>{item.name}</p>
          <p className="text-[10px] text-slate-600 font-mono">{fmtSize(item.size)}</p>
        </div>

        {(item.status === 'queued' || item.status === 'uploading' || item.status === 'classifying') && (
          <span className="inline-flex items-center gap-1.5 text-[11px] text-slate-400">
            <Loader2 size={13} className="animate-spin text-indigo-400" />
            {item.status === 'queued' ? 'Waiting…' : item.status === 'uploading' ? 'Uploading…' : 'Working out what this is…'}
          </span>
        )}

        {item.status === 'error' && (
          <span className="inline-flex items-center gap-2 text-[11px] text-red-400">
            <AlertTriangle size={12} /> {item.error}
            {item.size > 0 && item.size <= MAX_BYTES && (
              <button type="button" onClick={onRetry} className="text-indigo-300 hover:text-indigo-200 underline">Retry</button>
            )}
          </span>
        )}

        {item.status === 'ready' && (
          <div className="flex flex-wrap items-center gap-2">
            <label htmlFor={selectId} className="text-[10px] uppercase tracking-wide text-slate-500">This is</label>
            <select
              id={selectId}
              value={item.docType}
              onChange={(e) => onCorrect(e.target.value as IntakeDocType)}
              disabled={!!item.done}
              className="max-w-[220px] px-2 py-1 bg-slate-900 border border-slate-700 rounded-md text-[11px] text-ink-hi focus:border-indigo-500 focus:outline-none"
            >
              {INTAKE_DOC_TYPES.map((t) => <option key={t} value={t}>{INTAKE_ROUTES[t].label}</option>)}
            </select>
            {item.source !== 'user' && item.docType !== 'UNKNOWN' && (
              <span
                className={clsx('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-mono', confidenceTone(item.confidence))}
                title={item.source === 'ai' ? 'Read by AI' : 'Read without AI — by file name and column headings'}
              >
                {item.source === 'ai' ? <Sparkles size={10} /> : <Wand2 size={10} />}
                {Math.round(item.confidence * 100)}% · {confidenceWords(item.confidence)}
              </span>
            )}
          </div>
        )}

        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove ${item.name} from this list`}
          className="shrink-0 p-1 rounded text-slate-600 hover:text-slate-300 hover:bg-slate-800"
        >
          <X size={13} />
        </button>
      </div>

      {item.status === 'ready' && handoff && (
        <div className="flex flex-wrap items-center gap-3 border-t border-slate-800/80 px-3 py-2">
          <p className="min-w-0 flex-1 text-[11px] text-slate-500">
            {item.done
              ? <span className="inline-flex items-center gap-1 text-emerald-400"><CheckCircle2 size={12} /> {item.done}</span>
              : <>
                  {item.note && item.source !== 'user' && <span className="text-slate-400">{item.note}. </span>}
                  {handoff.formatProblem
                    ? <span className="text-amber-300/90">{handoff.formatProblem}</span>
                    : handoff.description}
                </>}
            {item.error && <span className="ml-1 text-red-400">{item.error}</span>}
          </p>

          {!item.done && (
            <div className="flex items-center gap-2">
              {handoff.kind === 'file' && handoff.href && (
                <Link href={handoff.href} className="text-[11px] text-slate-400 hover:text-slate-200 underline-offset-2 hover:underline">
                  Open {INTAKE_ROUTES[item.docType].label.split(' / ')[0]}
                </Link>
              )}
              {needsCompany ? (
                <span className="text-[11px] text-amber-300">Create a company first</span>
              ) : handoff.kind === 'opening' && handoff.href ? (
                <Link
                  href={handoff.href}
                  className="inline-flex items-center gap-1 rounded-md bg-brand-500 hover:bg-brand-400 px-2.5 py-1 text-[11px] font-medium text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/60"
                >
                  {handoff.actionLabel} <ArrowRight size={12} />
                </Link>
              ) : handoff.kind === 'file' ? (
                <button
                  type="button"
                  onClick={onFile}
                  disabled={item.busy}
                  className="inline-flex items-center gap-1 rounded-md border border-slate-700 bg-slate-800/60 hover:bg-slate-800 px-2.5 py-1 text-[11px] font-medium text-slate-200 disabled:opacity-50"
                >
                  {item.busy ? <Loader2 size={12} className="animate-spin" /> : <FolderArchive size={12} />} {handoff.actionLabel}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => (expanded ? onClose() : onOpen(handoff.kind))}
                  aria-expanded={expanded}
                  className="inline-flex items-center gap-1 rounded-md bg-indigo-500/15 hover:bg-indigo-500/25 border border-indigo-500/30 px-2.5 py-1 text-[11px] font-medium text-indigo-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/60"
                >
                  {expanded && (handoff.kind === 'formation' || handoff.kind === 'ar' || handoff.kind === 'ap') ? 'Hide' : handoff.actionLabel}
                  <ArrowRight size={12} />
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {/* In-page receivers — the same storage path, no re-upload. */}
      {expanded && item.storagePath && handoff && !item.done && (
        <>
          {handoff.kind === 'formation' && (
            <div className="border-t border-slate-800/80 p-3">
              <FormationIntake
                embedded
                companyId={companyId}
                initialStoragePath={item.storagePath}
                onSaved={(name) => onDone(`Legal record saved for ${name}.`)}
              />
            </div>
          )}
          {handoff.kind === 'ar' && companyId && (
            <div className="border-t border-slate-800/80 p-3">
              <ArReviewComponent
                companyId={companyId}
                initialStoragePath={item.storagePath}
                initialKind={handoff.subledgerKind === 'customers' ? 'customers' : 'open_ar'}
                onCommitted={() => onDone(handoff.subledgerKind === 'customers' ? 'Customers brought in.' : 'Open receivables brought in.')}
              />
            </div>
          )}
          {handoff.kind === 'ap' && companyId && (
            <div className="border-t border-slate-800/80 p-3">
              <ApReviewComponent
                companyId={companyId}
                initialStoragePath={item.storagePath}
                initialKind={handoff.subledgerKind === 'vendors' ? 'vendors' : 'open_ap'}
                onCommitted={() => onDone(handoff.subledgerKind === 'vendors' ? 'Vendors brought in.' : 'Open payables brought in.')}
              />
            </div>
          )}
        </>
      )}
    </li>
  );
}
