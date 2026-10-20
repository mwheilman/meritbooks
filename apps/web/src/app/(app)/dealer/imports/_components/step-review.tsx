'use client';

/**
 * Wizard step 3b — review every row before anything is created. Works the same for a
 * mapped spreadsheet and an AI proposal: every cell is editable, each row shows its
 * problems in plain English, AI rows carry the indigo badge + confidence and low-
 * confidence rows are highlighted. Statements show their footer totals and a live
 * footing check — submit stays blocked until the lines add up (AC11).
 */

import { useMemo, useState } from 'react';
import { clsx } from 'clsx';
import { AlertTriangle, CheckCircle2, Loader2, RefreshCw, Scale } from 'lucide-react';
import { ConfidenceBar } from '@/components/ui/confidence-bar';
import type { ImportFileKind, StatementKind } from '@/lib/dealer/types';
import { KIND_FIELDS, ROW_NOUN, isLenderKind, isStatementKind, type TargetField } from '@/lib/dealer/imports/fields';
import { validateRows, type ImportContext, type LenderStatementBody, type OemStatementBody, type RowCheck } from '@/lib/dealer/imports/targets';
import { assembleLenderStatement, assembleOemStatement, FOOTING_MESSAGE, lenderHeaderFrom, oemHeaderFrom } from '@/lib/dealer/imports/statements';
import { STATEMENT_KIND } from '@/lib/dealer/ui/labels';
import { money } from '@/lib/dealer/ui/format';
import { DateInput, Field, Select, TextInput } from '../../_components/forms';
import { Segments } from '../../_components/dealer-table';
import { AiBadge, Notice } from '../../_components/ui';
import type { ReviewRow } from '../_lib/wizard';
import type { SubmitItem } from '../_lib/submit';
import type { BatchError } from '../_lib/submit';

export type ReviewSubmit =
  | { type: 'rows'; items: SubmitItem[]; rejected: BatchError[]; total: number }
  | { type: 'lender'; body: LenderStatementBody; total: number }
  | { type: 'oem'; body: OemStatementBody; total: number };

const PAGE = 50;
type Filter = 'all' | 'problems' | 'low' | 'excluded';

const STATEMENT_KINDS = (Object.keys(STATEMENT_KIND) as StatementKind[]).map((k) => ({ value: k, label: STATEMENT_KIND[k] }));

function isMoney(f: TargetField): boolean {
  return f.type === 'money' || f.type === 'signedMoney';
}

export function StepReview({
  kind,
  source,
  rows,
  onRows,
  header,
  onHeader,
  ctx,
  documentId,
  aiMeta,
  checking,
  resolveError,
  onRecheck,
  busy,
  onBack,
  onSubmit,
}: {
  kind: ImportFileKind;
  source: 'ai' | 'mapping';
  rows: ReviewRow[];
  onRows: (rows: ReviewRow[]) => void;
  header: Record<string, string>;
  onHeader: (h: Record<string, string>) => void;
  ctx: ImportContext;
  documentId: string | null;
  aiMeta: { confidence: number; documentNote: string | null; model: string } | null;
  checking: boolean;
  resolveError: string | null;
  onRecheck: () => void;
  busy: boolean;
  onBack: () => void;
  onSubmit: (s: ReviewSubmit) => void;
}) {
  const [filter, setFilter] = useState<Filter>('all');
  const [page, setPage] = useState(1);
  const fields = KIND_FIELDS[kind];
  const noun = ROW_NOUN[kind];
  const statement = isStatementKind(kind);

  const includedIdx = useMemo(() => rows.flatMap((r, i) => (r.excluded ? [] : [i])), [rows]);
  const includedCells = useMemo(() => includedIdx.map((i) => rows[i].cells), [includedIdx, rows]);
  const check = useMemo(() => validateRows(kind, includedCells, ctx), [kind, includedCells, ctx]);
  const byRow = useMemo(() => {
    const m = new Map<number, RowCheck>();
    includedIdx.forEach((rowIndex, k) => m.set(rowIndex, check.results[k]));
    return m;
  }, [includedIdx, check]);

  const lender = useMemo(
    () => (isLenderKind(kind) ? assembleLenderStatement(lenderHeaderFrom(header, kind === 'LENDER_AUDIT' ? 'AUDIT' : 'STATEMENT'), includedCells, { ...ctx, documentId }) : null),
    [kind, header, includedCells, ctx, documentId],
  );
  const oem = useMemo(
    () => (kind === 'OEM_STATEMENT' ? assembleOemStatement(oemHeaderFrom(header), includedCells, { ...ctx, documentId }) : null),
    [kind, header, includedCells, ctx, documentId],
  );

  const shownFields = useMemo(
    () => fields.filter((f) => f.required || rows.some((r) => (r.cells[f.key] ?? '') !== '')),
    [fields, rows],
  );

  const visible = useMemo(() => {
    return rows
      .map((r, i) => ({ r, i }))
      .filter(({ r, i }) => {
        if (filter === 'excluded') return r.excluded;
        if (filter === 'low') return !r.excluded && r.lowConfidence;
        if (filter === 'problems') return !r.excluded && byRow.get(i)?.ok === false;
        return true;
      });
  }, [rows, filter, byRow]);
  const pages = Math.max(1, Math.ceil(visible.length / PAGE));
  const curPage = Math.min(page, pages);
  const pageRows = visible.slice((curPage - 1) * PAGE, curPage * PAGE);

  const lowCount = rows.filter((r) => !r.excluded && r.lowConfidence).length;
  const excludedCount = rows.length - includedIdx.length;

  function editCell(i: number, key: string, value: string) {
    const next = rows.slice();
    next[i] = { ...next[i], cells: { ...next[i].cells, [key]: value } };
    onRows(next);
  }
  function toggle(i: number) {
    const next = rows.slice();
    next[i] = { ...next[i], excluded: !next[i].excluded, excludedReason: next[i].excluded ? undefined : 'Left out by you' };
    onRows(next);
  }

  const canSubmit = statement ? !!(lender?.ok || oem?.ok) : check.accepted > 0;

  function submit() {
    if (lender?.body) return onSubmit({ type: 'lender', body: lender.body, total: rows.length });
    if (oem?.body) return onSubmit({ type: 'oem', body: oem.body, total: rows.length });
    const items: SubmitItem[] = [];
    const rejected: BatchError[] = [];
    includedIdx.forEach((rowIndex, k) => {
      const res = check.results[k];
      const sourceRow = rows[rowIndex].sourceRow;
      if (res.ok) items.push({ index: rowIndex, sourceRow, plan: res.plan });
      else rejected.push({ row: sourceRow ?? rowIndex + 1, message: res.errors.join(' ') });
    });
    rows.forEach((r, i) => {
      if (r.excluded) rejected.push({ row: r.sourceRow ?? i + 1, message: r.excludedReason ?? 'Left out' });
    });
    onSubmit({ type: 'rows', items, rejected, total: rows.length });
  }

  const footing = lender?.footing ?? null;
  const oemFooting = oem?.footing ?? null;
  const statementProblems = lender?.problems ?? oem?.problems ?? [];

  return (
    <div className="space-y-5">
      {aiMeta && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-indigo-500/20 bg-indigo-500/[0.04] px-4 py-3 text-sm text-slate-300">
          <AiBadge confidenceBps={Math.round(aiMeta.confidence * 10_000)} title="Average confidence of the AI read" />
          <span>
            The AI read <span className="font-mono tabular-nums text-white">{rows.length}</span> {noun}
            {rows.length === 1 ? '' : 's'}. Check the highlighted rows — nothing is created until you import.
          </span>
          {aiMeta.documentNote && <span className="w-full text-xs text-indigo-200/80">Note from the read: {aiMeta.documentNote}</span>}
        </div>
      )}

      {statement && (
        <section aria-label="Statement totals" className="rounded-lg border border-slate-800 bg-surface-950 p-4">
          <h3 className="mb-3 flex items-center gap-2 text-subheading text-white">
            <Scale size={15} className="text-slate-400" /> Statement totals
          </h3>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
            {isLenderKind(kind) && (
              <Field label="Document" htmlFor="st-kind">
                <Select<StatementKind> id="st-kind" value={(header.statementKind as StatementKind) || 'STATEMENT'} onChange={(v) => onHeader({ ...header, statementKind: v })} options={STATEMENT_KINDS} />
              </Field>
            )}
            <Field label="Statement date" htmlFor="st-date" required>
              <DateInput id="st-date" value={header.statementDate ?? ''} onChange={(v) => onHeader({ ...header, statementDate: v })} />
            </Field>
            {isLenderKind(kind) ? (
              <>
                <Field label="Principal total" htmlFor="st-p" required>
                  <TextInput id="st-p" inputMode="decimal" className="text-right font-mono" value={header.footerPrincipal ?? ''} onChange={(v) => onHeader({ ...header, footerPrincipal: v })} placeholder="0.00" />
                </Field>
                <Field label="Interest total" htmlFor="st-i" hint="If printed">
                  <TextInput id="st-i" inputMode="decimal" className="text-right font-mono" value={header.footerInterest ?? ''} onChange={(v) => onHeader({ ...header, footerInterest: v })} placeholder="—" />
                </Field>
                <Field label="Fees total" htmlFor="st-f" hint="If printed">
                  <TextInput id="st-f" inputMode="decimal" className="text-right font-mono" value={header.footerFees ?? ''} onChange={(v) => onHeader({ ...header, footerFees: v })} placeholder="—" />
                </Field>
                <Field label="Line count" htmlFor="st-n" hint="If printed">
                  <TextInput id="st-n" inputMode="numeric" className="text-right font-mono" value={header.footerLineCount ?? ''} onChange={(v) => onHeader({ ...header, footerLineCount: v })} placeholder="—" />
                </Field>
              </>
            ) : (
              <Field label="Statement total (credits positive)" htmlFor="st-t" required>
                <TextInput id="st-t" inputMode="decimal" className="text-right font-mono" value={header.footerTotal ?? ''} onChange={(v) => onHeader({ ...header, footerTotal: v })} placeholder="0.00" />
              </Field>
            )}
          </div>

          <div
            role="status"
            aria-live="polite"
            className={clsx(
              'mt-4 flex flex-wrap items-center gap-x-6 gap-y-1 rounded-md border px-3 py-2 text-sm',
              lender?.ok || oem?.ok ? 'border-emerald-500/30 bg-emerald-500/[0.05] text-emerald-200' : 'border-amber-500/30 bg-amber-500/[0.05] text-amber-100',
            )}
          >
            {lender?.ok || oem?.ok ? <CheckCircle2 size={15} className="text-emerald-400" /> : <AlertTriangle size={15} className="text-amber-400" />}
            {footing && (
              <span className="font-mono tabular-nums">
                Lines: principal {money(footing.sums.principalCents)} · interest {money(footing.sums.interestCents)} · fees {money(footing.sums.feesCents)} · {footing.sums.lineCount} lines
              </span>
            )}
            {oemFooting && (
              <span className="font-mono tabular-nums">
                Lines total {money(oemFooting.sumCents)}
                {oemFooting.differenceCents !== null && oemFooting.differenceCents !== 0 && <> · off by {money(oemFooting.differenceCents)}</>}
              </span>
            )}
            <span className="w-full">{lender?.ok || oem?.ok ? 'The lines add up to the statement totals.' : statementProblems.length ? statementProblems.join(' ') : FOOTING_MESSAGE}</span>
          </div>
        </section>
      )}

      {resolveError && (
        <Notice tone="warning" action={<button type="button" className="btn-secondary btn-sm" onClick={onRecheck}>Try again</button>}>
          Names and serials couldn’t be checked against Books: {resolveError}
        </Notice>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <Segments<Filter>
          label="Show rows"
          value={filter}
          onChange={(v) => {
            setFilter(v);
            setPage(1);
          }}
          options={[
            { value: 'all', label: 'All', count: rows.length },
            { value: 'problems', label: 'Problems', count: check.rejected },
            ...(source === 'ai' ? [{ value: 'low' as const, label: 'Low confidence', count: lowCount }] : []),
            { value: 'excluded', label: 'Left out', count: excludedCount },
          ]}
        />
        <div className="flex items-center gap-3 text-xs text-slate-500">
          {checking && (
            <span className="inline-flex items-center gap-1">
              <Loader2 size={12} className="animate-spin" /> Checking Books…
            </span>
          )}
          {(kind === 'DEALS' || kind === 'WARRANTY' || kind === 'UNITS' || kind === 'OPENING') && (
            <button type="button" className="inline-flex items-center gap-1 hover:text-slate-300" onClick={onRecheck}>
              <RefreshCw size={12} /> Check Books again
            </button>
          )}
        </div>
      </div>

      <div className="overflow-x-auto rounded-lg border border-slate-800">
        <table className="w-full text-xs">
          <caption className="sr-only">Rows to import</caption>
          <thead className="bg-surface-950 text-left text-slate-500">
            <tr>
              <th scope="col" className="w-10 px-2 py-2 font-medium"><span className="sr-only">Include</span></th>
              <th scope="col" className="px-2 py-2 font-medium">Row</th>
              {source === 'ai' && <th scope="col" className="px-2 py-2 font-medium">AI</th>}
              {shownFields.map((f) => (
                <th key={f.key} scope="col" className={clsx('whitespace-nowrap px-2 py-2 font-medium', isMoney(f) && 'text-right')}>
                  {f.label}
                  {f.required && <span className="ml-0.5 text-red-400" aria-hidden>*</span>}
                </th>
              ))}
              <th scope="col" className="min-w-[16rem] px-2 py-2 font-medium">Check</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/70">
            {pageRows.map(({ r, i }) => {
              const res = byRow.get(i);
              return (
                <tr key={r.id} className={clsx(r.excluded ? 'opacity-50' : r.lowConfidence ? 'bg-indigo-500/[0.05]' : res && !res.ok ? 'bg-amber-500/[0.03]' : undefined)}>
                  <td className="px-2 py-1">
                    <input type="checkbox" checked={!r.excluded} onChange={() => toggle(i)} aria-label={`Include row ${r.sourceRow ?? i + 1}`} className="h-3.5 w-3.5 accent-emerald-500" />
                  </td>
                  <td className="px-2 py-1 font-mono tabular-nums text-slate-500">{r.sourceRow ?? i + 1}</td>
                  {source === 'ai' && (
                    <td className="w-24 px-2 py-1">
                      {r.confidence !== null && <ConfidenceBar value={r.confidence} />}
                    </td>
                  )}
                  {shownFields.map((f) => {
                    const v = r.cells[f.key] ?? '';
                    const review = r.alwaysReview.includes(f.key);
                    return (
                      <td key={f.key} className="px-1 py-1">
                        <input
                          value={v}
                          onChange={(e) => editCell(i, f.key, e.target.value)}
                          aria-label={`${f.label}, row ${r.sourceRow ?? i + 1}`}
                          disabled={r.excluded}
                          title={review ? 'Always confirmed by a person' : undefined}
                          className={clsx(
                            'h-7 w-full min-w-[6.5rem] rounded border bg-surface-950 px-2 font-mono text-xs text-slate-200 focus:border-emerald-500/60 focus:outline-none',
                            isMoney(f) && 'text-right tabular-nums',
                            review ? 'border-indigo-500/50' : f.required && !v ? 'border-amber-500/40' : 'border-slate-800',
                          )}
                        />
                      </td>
                    );
                  })}
                  <td className="px-2 py-1 align-middle">
                    {r.excluded ? (
                      <span className="text-slate-500">{r.excludedReason ?? 'Left out'}</span>
                    ) : res?.ok ? (
                      <span className="text-emerald-400">
                        Ready{res.warnings.length > 0 && <span className="ml-1 text-slate-400">· {res.warnings.join(' ')}</span>}
                      </span>
                    ) : (
                      <span className="text-amber-300">{res?.errors.join(' ')}</span>
                    )}
                  </td>
                </tr>
              );
            })}
            {pageRows.length === 0 && (
              <tr>
                <td colSpan={shownFields.length + 4} className="px-3 py-8 text-center text-slate-500">No rows in this view.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {pages > 1 && (
        <div className="flex items-center justify-end gap-2 text-xs text-slate-400">
          <button type="button" className="btn-secondary btn-sm" disabled={curPage <= 1} onClick={() => setPage(curPage - 1)}>Previous</button>
          <span className="font-mono tabular-nums">
            {curPage} / {pages}
          </span>
          <button type="button" className="btn-secondary btn-sm" disabled={curPage >= pages} onClick={() => setPage(curPage + 1)}>Next</button>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-800 pt-4">
        <p className="text-sm text-slate-400">
          <span className="font-mono tabular-nums text-emerald-400">{check.accepted.toLocaleString()}</span> ready
          {check.rejected > 0 && (
            <>
              {' '}· <span className="font-mono tabular-nums text-amber-300">{check.rejected.toLocaleString()}</span> with problems{statement ? ' (fix them to import)' : ' (skipped and listed on the import)'}
            </>
          )}
          {excludedCount > 0 && <> · {excludedCount} left out</>}
        </p>
        <div className="flex gap-2">
          <button type="button" className="btn-secondary btn-sm" onClick={onBack} disabled={busy}>Back</button>
          <button type="button" className="btn-primary btn-sm inline-flex items-center gap-1.5" disabled={!canSubmit || busy} onClick={submit}>
            {busy && <Loader2 size={13} className="animate-spin" />}
            {statement ? 'Import statement' : `Import ${check.accepted.toLocaleString()} ${noun}${check.accepted === 1 ? '' : 's'}`}
          </button>
        </div>
      </div>
    </div>
  );
}
