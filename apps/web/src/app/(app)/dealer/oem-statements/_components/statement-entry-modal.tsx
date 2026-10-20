'use client';

/**
 * Manual manufacturer-statement entry (POST /api/dealer/oem-statements,
 * oemStatementImport): manufacturer, date, footer total and the lines as the
 * manufacturer states them (signed — credits positive, debits negative), with a live
 * footing check. The server refuses a statement whose lines don't add up to the
 * footer (NOT_FOOTING), so this form won't submit one. AI / CSV import lives in Imports.
 */

import { useEffect, useId, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { clsx } from 'clsx';
import { Check, Loader2, Plus, Trash2 } from 'lucide-react';
import { OEM_LINE_TYPE } from '@/lib/dealer/ui/labels';
import { money, todayLocal } from '@/lib/dealer/ui/format';
import { dealerLinks } from '@/lib/dealer/ui/links';
import { footing } from '@/lib/dealer/ui/claims';
import type { OemLineType } from '@/lib/dealer/types';
import { dealerMutate, type DealerApiError } from '../../_lib/use-dealer';
import { DateInput, Field, Modal, MoneyInput, Select, TextInput } from '../../_components/forms';
import { LookupPicker } from '../../_components/lookup-picker';
import { ErrorPanel } from '../../_components/ui';

interface LineDraft {
  key: number;
  lineType: OemLineType;
  reference: string;
  serialNumber: string;
  description: string;
  amountCents: number | null;
}

const TYPES = Object.keys(OEM_LINE_TYPE) as OemLineType[];
let seq = 0;
const blank = (lineType: OemLineType = 'WARRANTY_CREDIT'): LineDraft => ({ key: ++seq, lineType, reference: '', serialNumber: '', description: '', amountCents: null });

export function StatementEntryModal({ open, onClose, locationId }: { open: boolean; onClose: () => void; locationId: string }) {
  const router = useRouter();
  const [oem, setOem] = useState<string | null>(null);
  const [date, setDate] = useState(todayLocal());
  const [footer, setFooter] = useState<number | null>(null);
  const [lines, setLines] = useState<LineDraft[]>([blank()]);
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<DealerApiError | null>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    setOem(null);
    setDate(todayLocal());
    setFooter(null);
    setLines([blank()]);
    setTouched(false);
    setError(null);
  }, [open]);

  const foot = footing(lines, footer);
  const lineErrors = lines.map((l) => {
    if (l.amountCents === null) return 'Enter the amount';
    if (l.amountCents === 0) return 'Amount can’t be zero';
    if ((l.lineType === 'WARRANTY_CREDIT' || l.lineType === 'INCENTIVE_CREDIT') && l.amountCents < 0) return 'Credits are positive';
    if (l.lineType === 'DEBIT' && l.amountCents > 0) return 'Debits are negative';
    return null;
  });
  const errors = {
    oem: oem ? null : 'Choose the manufacturer',
    date: /^\d{4}-\d{2}-\d{2}$/.test(date) ? null : 'Choose the statement date',
    footer: footer === null ? 'Enter the statement total' : null,
    lines: lines.length === 0 ? 'Add at least one line' : null,
  };
  const valid = !errors.oem && !errors.date && !errors.footer && !errors.lines && lineErrors.every((e) => !e) && foot.foots;

  function patch(key: number, p: Partial<LineDraft>) {
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...p } : l)));
  }

  async function save() {
    setTouched(true);
    if (!valid) return;
    setBusy(true);
    setError(null);
    const res = await dealerMutate<{ id: string; lineCount: number }>(
      'post',
      '/api/dealer/oem-statements',
      locationId,
      {
        oemVendorId: oem,
        statementDate: date,
        footerTotalCents: footer,
        lines: lines.map((l) => ({
          lineType: l.lineType,
          reference: l.reference.trim() || null,
          serialNumber: l.serialNumber.trim() || null,
          description: l.description.trim() || null,
          amountCents: l.amountCents,
        })),
      },
      'Statement saved — find matches next',
    );
    setBusy(false);
    if (res.error || !res.data) return setError(res.error);
    onClose();
    router.push(dealerLinks.oemStatement(res.data.id));
  }

  const show = (e: string | null) => (touched ? e : null);

  return (
    <Modal
      open={open}
      onClose={busy ? () => undefined : onClose}
      width="xl"
      title="Enter a manufacturer statement"
      description={
        <>
          Type the lines as the statement shows them — credits positive, debits negative. Have a PDF or spreadsheet?{' '}
          <Link href={dealerLinks.imports()} className="text-emerald-400 hover:text-emerald-300">
            Import it instead
          </Link>
          .
        </>
      }
      footer={
        <>
          <span className={clsx('mr-auto inline-flex items-center gap-1.5 text-xs', foot.foots ? 'text-emerald-400' : 'text-slate-400')} aria-live="polite">
            {foot.foots ? (
              <>
                <Check size={13} /> Lines add up to the statement total
              </>
            ) : footer === null ? (
              'Enter the statement total to check the lines'
            ) : (
              <>
                Lines total <span className="font-mono tabular-nums text-slate-200">{money(foot.linesTotalCents)}</span> — off by{' '}
                <span className="font-mono tabular-nums text-amber-300">{money(foot.differenceCents)}</span>
              </>
            )}
          </span>
          <button type="button" className="btn-secondary btn-sm" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn-primary btn-sm" disabled={busy || (touched && !valid)} onClick={() => void save()}>
            {busy && <Loader2 size={13} className="animate-spin" />}
            Save statement
          </button>
        </>
      }
    >
      <form
        noValidate
        className="space-y-5"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Field label="Manufacturer" htmlFor={`${id}-o`} required error={show(errors.oem)}>
            <LookupPicker id={`${id}-o`} kind="vendors" value={oem} onChange={(v) => setOem(v)} placeholder="Choose…" invalid={!!show(errors.oem)} />
          </Field>
          <Field label="Statement date" htmlFor={`${id}-d`} required error={show(errors.date)}>
            <DateInput id={`${id}-d`} value={date} onChange={setDate} />
          </Field>
          <Field label="Statement total" htmlFor={`${id}-f`} required error={show(errors.footer)} hint="Net of credits and debits, as printed">
            <MoneyInput id={`${id}-f`} cents={footer} onChange={setFooter} allowNegative invalid={!!show(errors.footer)} />
          </Field>
        </div>

        <div className="overflow-x-auto rounded-lg border border-slate-800">
          <table className="w-full text-body-sm">
            <thead>
              <tr className="border-b border-slate-800 text-left text-caption uppercase tracking-caps text-slate-500">
                <th scope="col" className="w-8 px-2 py-2 text-right">#</th>
                <th scope="col" className="px-2 py-2">Type</th>
                <th scope="col" className="px-2 py-2">Claim # / reference</th>
                <th scope="col" className="px-2 py-2">Serial</th>
                <th scope="col" className="px-2 py-2">Description</th>
                <th scope="col" className="w-36 px-2 py-2 text-right">Amount</th>
                <th scope="col" className="w-8 px-2 py-2"><span className="sr-only">Remove</span></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/50">
              {lines.map((l, i) => (
                <tr key={l.key} className="align-top">
                  <td className="px-2 py-2 text-right font-mono text-2xs tabular-nums text-slate-500">{i + 1}</td>
                  <td className="px-2 py-1.5">
                    <Select<OemLineType> aria-label={`Line ${i + 1} type`} value={l.lineType} onChange={(v) => patch(l.key, { lineType: v })} options={TYPES.map((t) => ({ value: t, label: OEM_LINE_TYPE[t] }))} />
                  </td>
                  <td className="px-2 py-1.5">
                    <TextInput aria-label={`Line ${i + 1} reference`} value={l.reference} onChange={(v) => patch(l.key, { reference: v })} maxLength={100} className="font-mono" />
                  </td>
                  <td className="px-2 py-1.5">
                    <TextInput aria-label={`Line ${i + 1} serial`} value={l.serialNumber} onChange={(v) => patch(l.key, { serialNumber: v })} maxLength={100} className="font-mono" />
                  </td>
                  <td className="px-2 py-1.5">
                    <TextInput aria-label={`Line ${i + 1} description`} value={l.description} onChange={(v) => patch(l.key, { description: v })} maxLength={500} />
                  </td>
                  <td className="px-2 py-1.5">
                    <MoneyInput aria-label={`Line ${i + 1} amount`} cents={l.amountCents} onChange={(v) => patch(l.key, { amountCents: v })} allowNegative invalid={!!show(lineErrors[i])} />
                    {show(lineErrors[i]) && <p className="mt-1 text-right text-2xs text-red-400">{lineErrors[i]}</p>}
                  </td>
                  <td className="px-2 py-2">
                    <button type="button" aria-label={`Remove line ${i + 1}`} onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))} disabled={lines.length === 1} className="rounded p-1 text-slate-500 hover:text-red-400 disabled:opacity-30">
                      <Trash2 size={13} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="flex items-center justify-between border-t border-slate-800 px-3 py-2">
            <button type="button" className="btn-ghost btn-sm" onClick={() => setLines((ls) => [...ls, blank(ls[ls.length - 1]?.lineType)])} disabled={lines.length >= 5000}>
              <Plus size={13} /> Add line
            </button>
            <span className="font-mono text-xs tabular-nums text-slate-400">
              {lines.length} line{lines.length === 1 ? '' : 's'} · {money(foot.linesTotalCents)}
            </span>
          </div>
        </div>
        {error && <ErrorPanel error={error} compact />}
        <button type="submit" hidden aria-hidden tabIndex={-1} />
      </form>
    </Modal>
  );
}
