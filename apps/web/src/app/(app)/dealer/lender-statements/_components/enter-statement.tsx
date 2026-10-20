'use client';

/**
 * Enter a lender statement / floor check by hand: header (line, kind, date), the
 * lender's footer totals, and the lines grid (add / remove / paste from a
 * spreadsheet). A live footing check — the same pure `footStatement` the server
 * runs — must pass before it can be saved; a 422 NOT_FOOTING lists the problems.
 */

import { useEffect, useId, useMemo, useState } from 'react';
import Link from 'next/link';
import { CheckCircle2, ClipboardPaste, Loader2, MinusCircle, Plus, Trash2, XCircle } from 'lucide-react';
import { clsx } from 'clsx';
import type { StatementKind } from '@/lib/dealer/types';
import { STATEMENT_KIND } from '@/lib/dealer/ui/labels';
import { dealerLinks } from '@/lib/dealer/ui/links';
import { todayLocal } from '@/lib/dealer/ui/format';
import type { DealerApiError } from '@/lib/dealer/ui/errors';
import { dealerMutate } from '../../_lib/use-dealer';
import { DateInput, Field, Modal, MoneyInput, Select, TextArea, TextInput } from '../../_components/forms';
import { LookupPicker } from '../../_components/lookup-picker';
import { ErrorPanel } from '../../_components/ui';
import { ProblemList } from '../../floor-plan/_components/bits';
import { blankLine, checkFooting, isBlank, parsePastedLines, toApiLines, validateLines, type FooterDraft, type StatementDraftLine } from '../../floor-plan/_lib/statement-entry';

const MAX_LINES = 5000;

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

export function EnterStatementModal({
  open,
  onClose,
  locationId,
  defaultLineId,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  locationId: string;
  defaultLineId: string | null;
  onCreated: (statementId: string) => void;
}) {
  const [lineId, setLineId] = useState<string | null>(defaultLineId);
  const [kind, setKind] = useState<StatementKind>('STATEMENT');
  const [date, setDate] = useState(todayLocal());
  const [footer, setFooter] = useState<FooterDraft>({ principalCents: null, interestCents: null, feesCents: null, lineCount: '' });
  const [lines, setLines] = useState<StatementDraftLine[]>([blankLine(), blankLine(), blankLine()]);
  const [notes, setNotes] = useState('');
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState('');
  const [pasteMsg, setPasteMsg] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<DealerApiError | null>(null);
  const f = { line: useId(), kind: useId(), date: useId(), fp: useId(), fi: useId(), ff: useId(), fc: useId(), notes: useId(), paste: useId() };

  useEffect(() => {
    if (open) {
      setLineId(defaultLineId);
      setKind('STATEMENT');
      setDate(todayLocal());
      setFooter({ principalCents: null, interestCents: null, feesCents: null, lineCount: '' });
      setLines([blankLine(), blankLine(), blankLine()]);
      setNotes('');
      setPasteOpen(false);
      setPasteText('');
      setPasteMsg(null);
      setTouched(false);
      setError(null);
    }
  }, [open, defaultLineId]);

  const lineErrors = validateLines(lines);
  const footing = useMemo(() => checkFooting(lines, footer), [lines, footer]);
  const apiLines = toApiLines(lines);
  const headErr = {
    line: !lineId ? 'Choose the line this statement is for.' : null,
    date: !/^\d{4}-\d{2}-\d{2}$/.test(date) ? 'Enter the statement date.' : null,
    notes: notes.length > 2000 ? 'Keep notes under 2,000 characters.' : null,
  };
  const canSave = !headErr.line && !headErr.date && !headErr.notes && Object.keys(lineErrors).length === 0 && footing.ok && apiLines.length <= MAX_LINES;
  const serverProblems = error?.code === 'NOT_FOOTING' ? (Array.isArray(rec(error.details).problems) ? (rec(error.details).problems as string[]) : []) : [];

  function setLine(key: string, patch: Partial<StatementDraftLine>) {
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }

  function applyPaste() {
    const { lines: parsed, skipped } = parsePastedLines(pasteText);
    if (!parsed.length) {
      setPasteMsg('Nothing to add — paste rows copied from the lender’s spreadsheet (one unit per row).');
      return;
    }
    setLines((ls) => [...ls.filter((l) => !isBlank(l)), ...parsed].slice(0, MAX_LINES));
    setPasteMsg(`Added ${parsed.length} line${parsed.length === 1 ? '' : 's'}${skipped ? `; skipped ${skipped} row${skipped === 1 ? '' : 's'} that weren’t lines (headers or unreadable amounts)` : ''}.`);
    setPasteText('');
  }

  async function save() {
    setTouched(true);
    if (!canSave || !lineId) return;
    setBusy(true);
    setError(null);
    const lineCount = footer.lineCount.trim() === '' ? null : Number(footer.lineCount.trim());
    const res = await dealerMutate<{ statement: { id: string }; lineCount: number }>(
      'post',
      '/api/dealer/lender-statements',
      locationId,
      {
        lineId,
        kind,
        statementDate: date,
        footer: { principalCents: footer.principalCents, interestCents: footer.interestCents, feesCents: footer.feesCents, lineCount },
        lines: apiLines,
        notes: notes.trim() || null,
      },
      'Statement saved — run the match next',
    );
    setBusy(false);
    if (res.error) setError(res.error);
    else if (res.data) {
      onClose();
      onCreated(res.data.statement.id);
    }
  }

  return (
    <Modal
      open={open}
      onClose={busy ? () => undefined : onClose}
      title="Enter a lender statement"
      description={
        <>
          For a short statement or floor check. Longer ones are faster through{' '}
          <Link href={dealerLinks.imports()} className="text-emerald-400 hover:text-emerald-300">
            Imports
          </Link>
          .
        </>
      }
      width="xl"
      footer={
        <>
          <span className="mr-auto text-xs text-slate-500">
            {apiLines.length} line{apiLines.length === 1 ? '' : 's'}
          </span>
          <button type="button" className="btn-secondary btn-sm" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn-primary btn-sm inline-flex items-center gap-1.5" onClick={() => void save()} disabled={busy || (touched && !canSave)}>
            {busy && <Loader2 size={13} className="animate-spin" />} Save statement
          </button>
        </>
      }
    >
      <div className="space-y-6">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Field label="Line" htmlFor={f.line} required error={touched ? headErr.line : null}>
            <LookupPicker id={f.line} kind="lines" value={lineId} onChange={setLineId} invalid={touched && !!headErr.line} placeholder="Choose a line" />
          </Field>
          <Field label="Kind" htmlFor={f.kind}>
            <Select<StatementKind> id={f.kind} value={kind} onChange={setKind} options={(Object.keys(STATEMENT_KIND) as StatementKind[]).map((k) => ({ value: k, label: STATEMENT_KIND[k] }))} />
          </Field>
          <Field label="Statement date" htmlFor={f.date} required error={touched ? headErr.date : null}>
            <DateInput id={f.date} value={date} onChange={setDate} />
          </Field>
        </div>

        <fieldset>
          <legend className="mb-2 text-caption uppercase tracking-caps text-slate-500">Totals printed on the statement</legend>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Field label="Principal total" htmlFor={f.fp} required>
              <MoneyInput id={f.fp} cents={footer.principalCents} onChange={(c) => setFooter((s) => ({ ...s, principalCents: c }))} invalid={touched && footer.principalCents === null} />
            </Field>
            <Field label="Interest total" htmlFor={f.fi} hint="Optional">
              <MoneyInput id={f.fi} cents={footer.interestCents} onChange={(c) => setFooter((s) => ({ ...s, interestCents: c }))} />
            </Field>
            <Field label="Fees total" htmlFor={f.ff} hint="Optional">
              <MoneyInput id={f.ff} cents={footer.feesCents} onChange={(c) => setFooter((s) => ({ ...s, feesCents: c }))} />
            </Field>
            <Field label="Number of lines" htmlFor={f.fc} hint="Optional">
              <TextInput id={f.fc} inputMode="numeric" value={footer.lineCount} onChange={(v) => setFooter((s) => ({ ...s, lineCount: v }))} className="text-right font-mono" />
            </Field>
          </div>
        </fieldset>

        <fieldset>
          <div className="mb-2 flex items-center justify-between">
            <legend className="text-caption uppercase tracking-caps text-slate-500">Lines</legend>
            <div className="flex gap-2">
              <button type="button" className="btn-ghost btn-sm inline-flex items-center gap-1" onClick={() => setPasteOpen((o) => !o)} aria-expanded={pasteOpen} aria-controls={f.paste}>
                <ClipboardPaste size={13} /> Paste from spreadsheet
              </button>
              <button type="button" className="btn-ghost btn-sm inline-flex items-center gap-1" onClick={() => setLines((ls) => [...ls, blankLine()])} disabled={lines.length >= MAX_LINES}>
                <Plus size={13} /> Add line
              </button>
            </div>
          </div>
          {pasteOpen && (
            <div id={f.paste} className="mb-3 rounded-lg border border-slate-800 bg-surface-950 p-3">
              <label htmlFor={`${f.paste}-ta`} className="mb-1 block text-xs text-slate-400">
                Copy rows from the lender’s spreadsheet in this column order: invoice #, serial, model, original, current, interest, fees, code, disposition date, days.
              </label>
              <TextArea id={`${f.paste}-ta`} value={pasteText} onChange={setPasteText} rows={4} placeholder="Paste here…" />
              <div className="mt-2 flex items-center gap-3">
                <button type="button" className="btn-secondary btn-sm" onClick={applyPaste} disabled={!pasteText.trim()}>
                  Add pasted rows
                </button>
                {pasteMsg && (
                  <span className="text-xs text-slate-400" role="status">
                    {pasteMsg}
                  </span>
                )}
              </div>
            </div>
          )}
          <div className="overflow-x-auto rounded-lg border border-slate-800">
            <table className="w-full min-w-[1100px] text-xs">
              <caption className="sr-only">Statement lines</caption>
              <thead className="bg-surface-950">
                <tr className="text-caption uppercase tracking-caps text-slate-500">
                  {['Invoice #', 'Serial', 'Model', 'Original', 'Current', 'Interest', 'Fees', 'Code', 'Disposition', 'Days', ''].map((h, i) => (
                    <th key={h || i} scope="col" className={clsx('px-2 py-2 font-medium', i >= 3 && i <= 6 ? 'text-right' : 'text-left')}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/50">
                {lines.map((l, i) => {
                  const e = touched || !isBlank(l) ? lineErrors[l.key] : undefined;
                  const n = i + 1;
                  return (
                    <tr key={l.key} className={clsx('align-top', e && 'bg-red-500/[0.04]')}>
                      <td className="w-28 px-1 py-1">
                        <TextInput aria-label={`Line ${n} invoice number`} value={l.lenderInvoiceNumber} onChange={(v) => setLine(l.key, { lenderInvoiceNumber: v })} maxLength={100} className="font-mono text-xs" />
                      </td>
                      <td className="w-32 px-1 py-1">
                        <TextInput aria-label={`Line ${n} serial`} value={l.serialNumber} onChange={(v) => setLine(l.key, { serialNumber: v })} maxLength={100} className="font-mono text-xs" />
                      </td>
                      <td className="w-28 px-1 py-1">
                        <TextInput aria-label={`Line ${n} model`} value={l.model} onChange={(v) => setLine(l.key, { model: v })} maxLength={200} className="text-xs" />
                      </td>
                      <td className="w-28 px-1 py-1">
                        <MoneyInput aria-label={`Line ${n} original`} cents={l.originalCents} onChange={(c) => setLine(l.key, { originalCents: c })} placeholder="" />
                      </td>
                      <td className="w-28 px-1 py-1">
                        <MoneyInput aria-label={`Line ${n} current balance`} cents={l.currentCents} onChange={(c) => setLine(l.key, { currentCents: c })} placeholder="" />
                      </td>
                      <td className="w-24 px-1 py-1">
                        <MoneyInput aria-label={`Line ${n} interest`} cents={l.interestCents} onChange={(c) => setLine(l.key, { interestCents: c })} placeholder="" />
                      </td>
                      <td className="w-24 px-1 py-1">
                        <MoneyInput aria-label={`Line ${n} fees`} cents={l.feesCents} onChange={(c) => setLine(l.key, { feesCents: c })} placeholder="" />
                      </td>
                      <td className="w-16 px-1 py-1">
                        <TextInput aria-label={`Line ${n} lender code`} value={l.lenderCode} onChange={(v) => setLine(l.key, { lenderCode: v })} maxLength={20} className="font-mono text-xs uppercase" />
                      </td>
                      <td className="w-36 px-1 py-1">
                        <DateInput aria-label={`Line ${n} disposition date`} value={l.dispositionDate} onChange={(v) => setLine(l.key, { dispositionDate: v })} className="text-xs" />
                      </td>
                      <td className="w-16 px-1 py-1">
                        <TextInput aria-label={`Line ${n} days`} inputMode="numeric" value={l.days} onChange={(v) => setLine(l.key, { days: v })} className="text-right font-mono text-xs" />
                      </td>
                      <td className="w-8 px-1 py-1">
                        <button type="button" aria-label={`Remove line ${n}`} className="btn-ghost btn-sm p-1.5" onClick={() => setLines((ls) => (ls.length > 1 ? ls.filter((x) => x.key !== l.key) : [blankLine()]))}>
                          <Trash2 size={12} />
                        </button>
                        {e && <span className="sr-only">{e}</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {Object.keys(lineErrors).length > 0 && (touched || lines.some((l) => !isBlank(l) && lineErrors[l.key])) && (
            <ul className="mt-2 space-y-0.5 text-xs text-red-400" role="alert">
              {lines.map((l, i) => (lineErrors[l.key] ? <li key={l.key}>Line {i + 1}: {lineErrors[l.key]}</li> : null))}
            </ul>
          )}
        </fieldset>

        <div className="rounded-lg border border-slate-800 bg-surface-950 p-4" aria-live="polite">
          <div className="mb-2 flex items-center gap-2">
            {footing.ok ? <CheckCircle2 size={15} className="text-emerald-400" /> : <XCircle size={15} className="text-red-400" />}
            <h3 className={clsx('text-sm font-medium', footing.ok ? 'text-emerald-300' : 'text-red-200')}>
              {footing.ok ? 'The lines add up to the statement totals' : 'The lines don’t add up to the statement totals yet'}
            </h3>
          </div>
          <table className="w-full max-w-xl text-xs">
            <caption className="sr-only">Footing check</caption>
            <thead>
              <tr className="text-caption uppercase tracking-caps text-slate-500">
                <th scope="col" className="pb-1 text-left font-medium" />
                <th scope="col" className="pb-1 text-right font-medium">Lines add to</th>
                <th scope="col" className="pb-1 text-right font-medium">Statement says</th>
                <th scope="col" className="w-6" />
              </tr>
            </thead>
            <tbody>
              {footing.rows.map((r) => (
                <tr key={r.label}>
                  <td className="py-0.5 text-slate-400">{r.label}</td>
                  <td className="py-0.5 text-right font-mono tabular-nums text-slate-200">{r.linesTotal}</td>
                  <td className="py-0.5 text-right font-mono tabular-nums text-slate-200">{r.footer}</td>
                  <td className="py-0.5 pl-2">
                    {r.ok === null ? (
                      <MinusCircle size={12} className="text-slate-600" aria-label="Not checked" />
                    ) : r.ok ? (
                      <CheckCircle2 size={12} className="text-emerald-400" aria-label="Matches" />
                    ) : (
                      <XCircle size={12} className="text-red-400" aria-label="Doesn’t match" />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2 text-2xs text-slate-500">Principal is the sum of each line’s current balance. A statement that doesn’t foot can’t be matched.</p>
        </div>

        <Field label="Notes" htmlFor={f.notes} error={headErr.notes}>
          <TextArea id={f.notes} value={notes} onChange={setNotes} rows={2} maxLength={2000} />
        </Field>

        {error && (
          <div>
            <ErrorPanel error={error} compact />
            <ProblemList problems={serverProblems} />
          </div>
        )}
      </div>
    </Modal>
  );
}

