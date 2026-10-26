'use client';

import { useState, useEffect } from 'react';
import { Button, Field, InlineNotice, Input, PanelSection, Select, Status, cx } from '@meritbooks/merit-ui';
import { useQuery, addToast } from '@/hooks';
import { formatMoney } from '@meritbooks/shared';
import { StatusBadge } from '@/components/ui';
import { DetailDrawer, DetailSection, DetailField, DetailTable } from '@/components/detail-drawer';
import { AttachmentsPanel } from '@/components/documents/attachments-panel';
import { ExplainPanel } from '@/components/explain-panel';
import { JE_SOURCE_LABELS, JE_TYPE_LABELS } from './je-labels';
import s from './je.module.css';

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

  const { data: acctResp, isLoading: acctLoading } = useQuery<{ recent: AccountOption[]; accounts: AccountOption[] }>(
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

  const totalDr = lines.reduce((sum, l) => sum + l.debitCents, 0);
  const totalCr = lines.reduce((sum, l) => sum + l.creditCents, 0);
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

  const sourceLabel = data?.sourceModule ? (JE_SOURCE_LABELS[data.sourceModule] ?? data.sourceModule) : null;

  return (
    <DetailDrawer
      open={!!entryId} onClose={onClose} width="lg"
      title={data?.entryNumber ?? 'Journal entry'}
      subtitle={data ? `${data.entryDate}${data.locationCode ? ` · ${data.locationCode}` : ''}` : null}
      isLoading={isLoading} error={error}
      headerRight={data ? (
        <>
          <StatusBadge status={data.status} />
          {!editing && (
            <Button onClick={beginEdit}>Edit</Button>
          )}
        </>
      ) : undefined}
    >
      {data && !editing && (
        <>
          <DetailSection title="Entry">
            <DetailField label="Memo" value={data.memo ?? '—'} />
            <DetailField label="Type" value={JE_TYPE_LABELS[data.entryType] ?? data.entryType} />
            <DetailField label="Source" value={sourceLabel ?? '—'} />
            <DetailField label="Company" value={data.locationName || '—'} />
            <DetailField label="Period" value={data.periodLabel ?? '—'} mono />
            <DetailField label="Posted" value={data.postedAt ? new Date(data.postedAt).toLocaleString() : '—'} mono />
            {data.isReversing && <DetailField label="Reversing" value="Yes" />}
            {data.voidReason && <DetailField label="Void reason" value={data.voidReason} />}
          </DetailSection>

          <PanelSection title="Lines" meta={<span className="t-cap tnum">{data.lines.length}</span>}>
            <DetailTable columns={[
              { key: 'acct', label: 'Account' }, { key: 'dim', label: 'Dimensions' },
              { key: 'dr', label: 'Debit', align: 'right' }, { key: 'cr', label: 'Credit', align: 'right' },
            ]}>
              {data.lines.map((l) => (
                <tr key={l.id}>
                  <td className={s.lineCell}>
                    <span className="l1"><span className="code">{l.accountNumber}</span>{l.accountName}</span>
                    {l.memo && <span className="l2">{l.memo}</span>}
                  </td>
                  <td className={cx('ink-2', s.lineCell)}>{[l.departmentLabel, l.classLabel].filter(Boolean).join(' · ') || '—'}</td>
                  <td className={cx('n', s.lineCell)}>{l.debitCents ? formatMoney(l.debitCents) : ''}</td>
                  <td className={cx('n', s.lineCell)}>{l.creditCents ? formatMoney(l.creditCents) : ''}</td>
                </tr>
              ))}
              <tr className={s.totalRow}>
                <td colSpan={2}>Totals</td>
                <td className="n">{formatMoney(data.totalDebitsCents)}</td>
                <td className="n">{formatMoney(data.totalCreditsCents)}</td>
              </tr>
            </DetailTable>
            <div className={s.balance}>
              {data.balanced ? <Status kind="ready">Balanced</Status> : <Status kind="blocked">Out of balance</Status>}
              {!data.balanced && (
                <span className="t-cap tnum">Off by {formatMoney(Math.abs(data.totalDebitsCents - data.totalCreditsCents))}</span>
              )}
            </div>
          </PanelSection>

          <PanelSection>
            <ExplainPanel kind="JOURNAL_ENTRY" id={data.id} />
          </PanelSection>

          <PanelSection>
            <AttachmentsPanel entityType="gl_entry" entityId={data.id} defaultDocType="OTHER" title="Supporting documents" />
          </PanelSection>
        </>
      )}

      {data && editing && (
        <>
          {needsOverride && (
            <PanelSection>
              <InlineNotice tone="warn" title="Posted entry — override required.">
                This entry is posted to the GL. Saving reverses it and re-posts a corrected entry; the change is audit-logged.
              </InlineNotice>
              <Field label="Reason for override" className={s.overrideField}>
                <Input
                  type="text"
                  value={overrideReason}
                  onChange={(e) => setOverrideReason(e.target.value)}
                  placeholder="Why this posted entry is being corrected (required)"
                  autoFocus
                />
              </Field>
            </PanelSection>
          )}

          <PanelSection title="Entry">
            <div className={s.editGrid}>
              <Field label="Memo">
                <Input type="text" value={memo} onChange={(e) => setMemo(e.target.value)} />
              </Field>
              <Field label="Entry date">
                <Input type="date" className="tnum" value={entryDate} onChange={(e) => setEntryDate(e.target.value)} />
              </Field>
            </div>
          </PanelSection>

          <PanelSection
            title="Lines"
            meta={
              <Button variant="quiet" icon="plus" onClick={() => setLines((p) => [...p, { accountId: '', debitCents: 0, creditCents: 0, memo: null }])}>
                Add line
              </Button>
            }
          >
            <div className={s.editLines}>
              <div className={cx('t-cap', s.editHead)} aria-hidden="true">
                <span>Account</span><span className="n">Debit</span><span className="n">Credit</span><span />
              </div>
              {lines.map((l, i) => (
                <div key={i} className={s.editLine}>
                  <Select value={l.accountId} onChange={(e) => updateLine(i, { accountId: e.target.value })} aria-label={`Line ${i + 1} account`}>
                    <option value="">{acctLoading && accountOptions.length === 0 ? 'Loading accounts…' : 'Account…'}</option>
                    {/* Keep the line's current account selectable even before the list arrives. */}
                    {l.accountId && !accountOptions.some((a) => a.id === l.accountId) && (
                      <option value={l.accountId}>{l.accountNumber ? `${l.accountNumber} · ${l.accountName ?? ''}` : 'Current account'}</option>
                    )}
                    {accountOptions.map((a) => <option key={a.id} value={a.id}>{a.account_number} · {a.name}</option>)}
                  </Select>
                  <span className={s.money}>
                    <span aria-hidden="true">$</span>
                    <input type="text" inputMode="decimal" autoComplete="off" className="input input--money" defaultValue={centsToInput(l.debitCents)} placeholder="Debit" aria-label={`Line ${i + 1} debit amount`} onChange={(e) => updateLine(i, { debitCents: inputToCents(e.target.value), creditCents: 0 })} />
                  </span>
                  <span className={s.money}>
                    <span aria-hidden="true">$</span>
                    <input type="text" inputMode="decimal" autoComplete="off" className="input input--money" defaultValue={centsToInput(l.creditCents)} placeholder="Credit" aria-label={`Line ${i + 1} credit amount`} onChange={(e) => updateLine(i, { creditCents: inputToCents(e.target.value), debitCents: 0 })} />
                  </span>
                  <Button variant="quiet" iconOnly icon="x" onClick={() => setLines((p) => p.filter((_, j) => j !== i))} aria-label={`Remove line ${i + 1}`} />
                </div>
              ))}
            </div>

            <div className={s.balance}>
              {balanced ? <Status kind="ready">Balanced</Status> : <Status kind="blocked">Out of balance</Status>}
              <span className="t-cap tnum">Debits {formatMoney(totalDr)} · Credits {formatMoney(totalCr)}</span>
            </div>
          </PanelSection>

          <div className={s.foot}>
            <Button variant="quiet" onClick={() => { setEditing(false); setNeedsOverride(false); }}>Cancel</Button>
            <Button variant="primary" onClick={save} disabled={saving || !balanced} aria-busy={saving || undefined}>
              {saving ? 'Saving…' : needsOverride ? 'Reverse & re-post' : 'Save'}
            </Button>
          </div>
        </>
      )}
    </DetailDrawer>
  );
}
