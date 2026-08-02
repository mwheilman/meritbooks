'use client';

import { useState, useEffect } from 'react';
import { clsx } from 'clsx';
import { Pencil, Plus, Trash2, Loader2, ShieldAlert } from 'lucide-react';
import { useQuery, addToast } from '@/hooks';
import { formatMoney } from '@meritbooks/shared';
import { StatusBadge } from '@/components/ui';
import { DetailDrawer, DetailSection, DetailField, DetailTable } from '@/components/detail-drawer';
import { AttachmentsPanel } from '@/components/documents/attachments-panel';
import { ExplainPanel } from '@/components/explain-panel';

interface JELineDetail {
  id: string; lineNumber: number; accountId: string | null;
  accountNumber: string; accountName: string;
  debitCents: number; creditCents: number; memo: string | null;
  departmentLabel: string | null; classLabel: string | null;
}
interface JEDetail {
  id: string; entryNumber: string; entryDate: string; entryType: string;
  memo: string | null; sourceModule: string | null; status: string;
  postedAt: string | null; createdAt: string; isReversing: boolean; voidReason: string | null;
  locationName: string; locationCode: string; periodLabel: string | null;
  totalDebitsCents: number; totalCreditsCents: number; balanced: boolean; lines: JELineDetail[];
}
interface AccountOption { id: string; account_number: string; name: string }
interface EditLine { accountId: string; debitCents: number; creditCents: number; memo: string | null; accountNumber?: string; accountName?: string }

const centsToInput = (c: number) => c ? (c / 100).toFixed(2) : '';
const inputToCents = (v: string) => Math.round((parseFloat(v.replace(/[^0-9.-]/g, '')) || 0) * 100);

export function JournalEntryDrawer({ entryId, onClose }: { entryId: string | null; onClose: () => void }) {
  const { data, isLoading, error, refetch } = useQuery<JEDetail>(
    entryId ? `/api/journal-entries/${entryId}` : '', undefined, { enabled: !!entryId }
  );

  const [editing, setEditing] = useState(false);
  const [needsOverride, setNeedsOverride] = useState(false);
  const [overrideReason, setOverrideReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [memo, setMemo] = useState('');
  const [entryDate, setEntryDate] = useState('');
  const [lines, setLines] = useState<EditLine[]>([]);

  const { data: acctResp } = useQuery<{ recent: AccountOption[]; accounts: AccountOption[] }>(
    '/api/accounts/search', undefined, { enabled: editing }
  );
  const accountOptions = [...(acctResp?.recent ?? []), ...(acctResp?.accounts ?? [])];

  useEffect(() => { setEditing(false); setNeedsOverride(false); setOverrideReason(''); }, [entryId]);

  function beginEdit() {
    if (!data) return;
    setMemo(data.memo ?? '');
    setEntryDate(data.entryDate);
    setLines(data.lines.map((l) => ({ accountId: l.accountId ?? '', debitCents: l.debitCents, creditCents: l.creditCents, memo: l.memo, accountNumber: l.accountNumber, accountName: l.accountName })));
    setNeedsOverride(data.status !== 'DRAFT');
    setEditing(true);
  }
  function updateLine(i: number, patch: Partial<EditLine>) { setLines((p) => p.map((l, j) => j === i ? { ...l, ...patch } : l)); }

  const totalDr = lines.reduce((s, l) => s + l.debitCents, 0);
  const totalCr = lines.reduce((s, l) => s + l.creditCents, 0);
  const balanced = totalDr === totalCr && totalDr > 0;

  async function save() {
    if (!data) return;
    if (!balanced) { addToast('error', 'Entry must balance before saving'); return; }
    if (lines.some((l) => !l.accountId)) { addToast('error', 'Every line needs an account'); return; }
    if (data.status !== 'DRAFT' && overrideReason.trim().length < 3) { addToast('error', 'Enter an override reason'); return; }
    setSaving(true);
    try {
      const res = await fetch(`/api/journal-entries/${data.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          memo, entry_date: entryDate,
          lines: lines.map((l) => ({ account_id: l.accountId, debit_cents: l.debitCents, credit_cents: l.creditCents, memo: l.memo })),
          ...(data.status !== 'DRAFT' ? { override: { reason: overrideReason.trim() } } : {}),
        }),
      });
      const result = await res.json().catch(() => ({}));
      if (res.ok && result?.ok) {
        addToast('success', result.reposted ? 'Reversed and re-posted (audit-logged)' : 'Entry updated');
        setEditing(false); setNeedsOverride(false); setOverrideReason('');
        if (result.reposted) onClose(); else refetch();
      } else {
        addToast('error', result?.error ?? 'Failed to save');
      }
    } catch { addToast('error', 'Network error while saving'); }
    finally { setSaving(false); }
  }

  return (
    <DetailDrawer
      open={!!entryId} onClose={onClose} width="lg"
      title={data?.entryNumber ?? 'Journal Entry'}
      subtitle={data ? `${data.entryDate}${data.locationCode ? ` · ${data.locationCode}` : ''}` : null}
      isLoading={isLoading} error={error}
      headerRight={data ? (
        <div className="flex items-center gap-2">
          <StatusBadge status={data.status} />
          {!editing && (
            <button onClick={beginEdit} className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium bg-slate-800 text-slate-200 hover:bg-slate-700">
              <Pencil size={12} /> Edit
            </button>
          )}
        </div>
      ) : undefined}
    >
      {data && !editing && (
        <>
          <DetailSection title="Entry">
            <DetailField label="Memo" value={data.memo ?? '--'} />
            <DetailField label="Type" value={data.entryType} />
            <DetailField label="Source" value={data.sourceModule ?? '--'} />
            <DetailField label="Company" value={data.locationName || '--'} />
            <DetailField label="Period" value={data.periodLabel ?? '--'} mono />
            <DetailField label="Posted" value={data.postedAt ? new Date(data.postedAt).toLocaleString() : '--'} />
            {data.isReversing && <DetailField label="Reversing" value="Yes" />}
            {data.voidReason && <DetailField label="Void reason" value={data.voidReason} />}
          </DetailSection>

          <h3 className="text-2xs text-slate-500 uppercase tracking-wider font-semibold mb-2">Lines ({data.lines.length})</h3>
          <DetailTable columns={[
            { key: 'acct', label: 'Account' }, { key: 'dim', label: 'Dimensions' },
            { key: 'dr', label: 'Debit', align: 'right' }, { key: 'cr', label: 'Credit', align: 'right' },
          ]}>
            {data.lines.map((l) => (
              <tr key={l.id} className="align-top">
                <td className="px-3 py-2">
                  <div className="text-sm text-slate-200"><span className="font-mono text-xs text-slate-400">{l.accountNumber}</span> {l.accountName}</div>
                  {l.memo && <div className="text-2xs text-slate-500 mt-0.5">{l.memo}</div>}
                </td>
                <td className="px-3 py-2 text-2xs text-slate-500">{[l.departmentLabel, l.classLabel].filter(Boolean).join(' · ') || '--'}</td>
                <td className="px-3 py-2 text-right text-sm font-mono tabular-nums text-slate-200">{l.debitCents ? formatMoney(l.debitCents) : ''}</td>
                <td className="px-3 py-2 text-right text-sm font-mono tabular-nums text-slate-200">{l.creditCents ? formatMoney(l.creditCents) : ''}</td>
              </tr>
            ))}
            <tr className="border-t border-slate-700 font-medium">
              <td className="px-3 py-2 text-xs text-slate-400" colSpan={2}>Totals</td>
              <td className="px-3 py-2 text-right text-sm font-mono tabular-nums text-slate-100">{formatMoney(data.totalDebitsCents)}</td>
              <td className="px-3 py-2 text-right text-sm font-mono tabular-nums text-slate-100">{formatMoney(data.totalCreditsCents)}</td>
            </tr>
          </DetailTable>
          <div className={clsx('mt-3 text-xs font-medium', data.balanced ? 'text-emerald-400' : 'text-red-400')}>
            {data.balanced ? '✓ Balanced' : '✗ Out of balance'}
          </div>

          <div className="mt-5">
            <ExplainPanel kind="JOURNAL_ENTRY" id={data.id} />
          </div>

          <div className="mt-5">
            <AttachmentsPanel entityType="gl_entry" entityId={data.id} defaultDocType="OTHER" title="Supporting documents" />
          </div>
        </>
      )}

      {data && editing && (
        <>
          {needsOverride && (
            <div className="mb-4 rounded-lg border border-amber-600/40 bg-amber-500/5 p-3">
              <div className="flex items-center gap-2 text-amber-400 text-sm font-medium mb-2"><ShieldAlert size={15} /> Posted entry — override required</div>
              <p className="text-2xs text-slate-400 mb-2">This entry is posted to the GL. Saving reverses it and re-posts a corrected entry; the change is audit-logged.</p>
              <input type="text" value={overrideReason} onChange={(e) => setOverrideReason(e.target.value)} placeholder="Reason for override (required)…"
                className="w-full px-3 py-2 rounded-md bg-slate-800/60 border border-slate-700 text-sm text-slate-200 placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-amber-500/40" />
            </div>
          )}

          <DetailSection title="Entry">
            <div className="px-4 py-3 space-y-3">
              <label className="block">
                <span className="text-2xs text-slate-500 uppercase tracking-wider font-semibold">Memo</span>
                <input type="text" value={memo} onChange={(e) => setMemo(e.target.value)} className="mt-1 w-full px-3 py-2 rounded-md bg-slate-800/60 border border-slate-700 text-sm text-slate-200" />
              </label>
              <label className="block">
                <span className="text-2xs text-slate-500 uppercase tracking-wider font-semibold">Entry date</span>
                <input type="date" value={entryDate} onChange={(e) => setEntryDate(e.target.value)} className="mt-1 w-full px-3 py-2 rounded-md bg-slate-800/60 border border-slate-700 text-sm text-slate-200" />
              </label>
            </div>
          </DetailSection>

          <div className="flex items-center justify-between mb-2">
            <h3 className="text-2xs text-slate-500 uppercase tracking-wider font-semibold">Lines</h3>
            <button onClick={() => setLines((p) => [...p, { accountId: '', debitCents: 0, creditCents: 0, memo: null }])} className="inline-flex items-center gap-1 text-xs text-emerald-400 hover:text-emerald-300"><Plus size={12} /> Add line</button>
          </div>
          <div className="space-y-2">
            {lines.map((l, i) => (
              <div key={i} className="grid grid-cols-12 gap-2 items-center rounded-lg bg-slate-800/30 p-2">
                <select value={l.accountId} onChange={(e) => updateLine(i, { accountId: e.target.value })} className="col-span-5 px-2 py-1.5 rounded bg-slate-800/60 border border-slate-700 text-xs text-slate-200">
                  <option value="">Account…</option>
                  {accountOptions.map((a) => <option key={a.id} value={a.id}>{a.account_number} · {a.name}</option>)}
                </select>
                <input type="text" inputMode="decimal" defaultValue={centsToInput(l.debitCents)} placeholder="Debit" onChange={(e) => updateLine(i, { debitCents: inputToCents(e.target.value), creditCents: 0 })} className="col-span-3 px-2 py-1.5 rounded bg-slate-800/60 border border-slate-700 text-xs text-slate-200 text-right font-mono" />
                <input type="text" inputMode="decimal" defaultValue={centsToInput(l.creditCents)} placeholder="Credit" onChange={(e) => updateLine(i, { creditCents: inputToCents(e.target.value), debitCents: 0 })} className="col-span-3 px-2 py-1.5 rounded bg-slate-800/60 border border-slate-700 text-xs text-slate-200 text-right font-mono" />
                <button onClick={() => setLines((p) => p.filter((_, j) => j !== i))} className="col-span-1 p-1 text-slate-500 hover:text-red-400"><Trash2 size={14} /></button>
              </div>
            ))}
          </div>

          <div className={clsx('mt-3 flex items-center justify-between rounded-lg px-4 py-2.5', balanced ? 'bg-emerald-500/[0.06]' : 'bg-red-500/[0.06]')}>
            <span className={clsx('text-xs font-medium', balanced ? 'text-emerald-400' : 'text-red-400')}>{balanced ? '✓ Balanced' : '✗ Out of balance'}</span>
            <span className="text-2xs font-mono text-slate-400">Dr {formatMoney(totalDr)} · Cr {formatMoney(totalCr)}</span>
          </div>

          <div className="mt-4 flex items-center justify-end gap-2">
            <button onClick={() => { setEditing(false); setNeedsOverride(false); }} className="px-4 py-2 rounded-md text-sm text-slate-400 hover:text-slate-200 hover:bg-white/[0.04]">Cancel</button>
            <button onClick={save} disabled={saving || !balanced} className={clsx('inline-flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium', saving || !balanced ? 'bg-slate-800 text-slate-600 cursor-not-allowed' : 'bg-emerald-600 text-white hover:bg-emerald-500')}>
              {saving ? <Loader2 size={14} className="animate-spin" /> : <Pencil size={14} />} Save
            </button>
          </div>
        </>
      )}
    </DetailDrawer>
  );
}
