'use client';

import { useCallback, useMemo, useRef, useState } from 'react';
import { Button, Check, Dialog, Field, Icon, InlineNotice, Input, Select, Tag } from '@meritbooks/merit-ui';
import { formatMoney, centsToDollars } from '@meritbooks/shared';
import { useQuery } from '@/hooks';
import { api } from '@/lib/api-client';
import { addToast } from '@/hooks/use-toast';
import s from './bank-feed-panels.module.css';

type StatementAccountType = 'CHECKING' | 'SAVINGS' | 'CREDIT_CARD' | 'LINE_OF_CREDIT';

interface AccountOption {
  id: string;
  label: string;
  mask: string | null;
  type: StatementAccountType;
  locationName: string;
  plaidLinked: boolean;
}

interface BalanceTie {
  checkable: boolean;
  openingCents: number | null;
  closingCents: number | null;
  sumCents: number;
  expectedSumCents: number | null;
  differenceCents: number | null;
  tied: boolean;
  toleranceCents: number;
}

interface ProposedLine {
  _id: string;
  transaction_date: string | null;
  description: string;
  amount_cents: number | null;
  direction: 'money_in' | 'money_out';
  running_balance_cents: number | null;
  confidence: number;
  lowConfidence: boolean;
  duplicate: boolean;
  dedupeKey: string;
}

interface ParseResponse {
  account: { id: string; label: string; mask: string | null; type: StatementAccountType };
  statement: {
    accountHeader: { name: string | null; last4: string | null; type: StatementAccountType | null };
    periodStart: string | null;
    periodEnd: string | null;
    openingCents: number | null;
    closingCents: number | null;
    balanceTie: BalanceTie;
    documentNote: string | null;
    transactions: ProposedLine[];
  };
  meta: { fileName: string; model: string; decisionId: string | null; lineCount: number; duplicateCount: number };
}

interface Row extends ProposedLine {
  include: boolean;
}

const ALLOWED = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/gif'];

function toRows(lines: ProposedLine[]): Row[] {
  // Default: exclude anything flagged as an existing duplicate (don't re-import).
  return lines.map((l) => ({ ...l, include: !l.duplicate }));
}

export function StatementImport({
  onClose,
  onImported,
}: {
  onClose: () => void;
  onImported: (count: number) => void;
}) {
  const [phase, setPhase] = useState<'select' | 'parsing' | 'review' | 'confirming'>('select');
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [accountId, setAccountId] = useState<string>('');
  const [parsed, setParsed] = useState<ParseResponse | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);

  const { data: acctData, isLoading: acctLoading } = useQuery<{ accounts: AccountOption[] }>(
    '/api/bank-feed/import-statement',
  );

  // Esc / the scrim close the dialog, except while parsing or confirming so a
  // keystroke can't abandon in-flight work.
  const busy = phase === 'parsing' || phase === 'confirming';
  const requestClose = useCallback(() => {
    if (!busy) onClose();
  }, [busy, onClose]);

  const accounts = acctData?.accounts ?? [];
  const manualAccounts = accounts.filter((a) => !a.plaidLinked);
  const selected = accounts.find((a) => a.id === accountId) ?? null;
  const isPlaid = selected?.plaidLinked ?? false;
  const canUpload = !!selected && !isPlaid;

  const parse = useCallback(
    async (file: File) => {
      setError(null);
      if (!accountId) {
        setError('Choose a target account first.');
        return;
      }
      if (!ALLOWED.includes(file.type)) {
        setError('Unsupported file type. Upload a PDF, JPEG, PNG, or WebP.');
        return;
      }
      if (file.size > 15 * 1024 * 1024) {
        setError('File too large. Maximum 15MB.');
        return;
      }
      setPhase('parsing');
      const formData = new FormData();
      formData.append('file', file);
      formData.append('bank_account_id', accountId);
      try {
        const res = await fetch('/api/bank-feed/import-statement', { method: 'POST', body: formData });
        const body = (await res.json()) as ParseResponse | { error: string };
        if (!res.ok || 'error' in body) {
          setError('error' in body ? body.error : 'Failed to parse statement');
          setPhase('select');
          return;
        }
        setParsed(body);
        setRows(toRows(body.statement.transactions));
        setPhase('review');
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Network error');
        setPhase('select');
      }
    },
    [accountId],
  );

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    if (!canUpload) return;
    const file = e.dataTransfer.files?.[0];
    if (file) void parse(file);
  }

  const setRow = <K extends keyof Row>(id: string, k: K, v: Row[K]) =>
    setRows((rs) => rs.map((r) => (r._id === id ? { ...r, [k]: v } : r)));

  function removeRow(id: string) {
    setRows((rs) => rs.filter((r) => r._id !== id));
  }

  const included = rows.filter((r) => r.include);
  const includedCount = included.length;
  const duplicateCount = rows.filter((r) => r.duplicate).length;

  // Live balance tie: opening/closing are fixed; the sum reflects edited amounts.
  const expectedSum = parsed?.statement.balanceTie.expectedSumCents ?? null;
  const liveSum = useMemo(() => included.reduce((acc, r) => acc + (r.amount_cents ?? 0), 0), [included]);
  const checkable = parsed?.statement.balanceTie.checkable ?? false;
  const liveDiff = expectedSum == null ? null : liveSum - expectedSum;
  const tied = liveDiff == null ? false : Math.abs(liveDiff) <= (parsed?.statement.balanceTie.toleranceCents ?? 0);

  function excludeDuplicates() {
    setRows((rs) => rs.map((r) => (r.duplicate ? { ...r, include: false } : r)));
  }

  async function confirmImport() {
    if (!parsed) return;
    const bad = included.filter((r) => !r.transaction_date || r.amount_cents == null || !r.description.trim());
    if (bad.length > 0) {
      addToast('error', 'Each included line needs a date, a description, and a non-zero amount.');
      return;
    }
    if (includedCount === 0) {
      addToast('error', 'Select at least one line to import.');
      return;
    }
    setPhase('confirming');
    const payload = {
      bank_account_id: parsed.account.id,
      decision_id: parsed.meta.decisionId,
      transactions: included.map((r) => ({
        transaction_date: r.transaction_date as string,
        description: r.description.trim(),
        amount_cents: r.amount_cents as number,
      })),
    };
    const res = await api.post<{ ok: true; inserted: number; skipped: number; total: number }>(
      '/api/bank-feed/import-statement/confirm',
      payload,
    );
    if (res.error || !res.data) {
      addToast('error', res.error?.error ?? 'Import failed');
      setPhase('review');
      return;
    }
    const { inserted, skipped } = res.data;
    addToast(
      'success',
      `${inserted} transaction${inserted === 1 ? '' : 's'} imported${skipped > 0 ? ` · ${skipped} duplicate${skipped === 1 ? '' : 's'} skipped` : ''}`,
    );
    onImported(inserted);
  }

  const allIncluded = rows.length > 0 && includedCount === rows.length;
  const someIncluded = includedCount > 0 && includedCount < rows.length;
  const setAllIncluded = (on: boolean) => setRows((rs) => rs.map((r) => ({ ...r, include: on })));
  const acctLabel = (a: { label: string; mask: string | null }) => `${a.label}${a.mask ? ` ••${a.mask}` : ''}`;
  const dropState = phase === 'parsing' ? 'busy' : !canUpload ? 'off' : dragOver ? 'over' : 'idle';
  const openPicker = () => {
    if (canUpload && phase === 'select') fileInput.current?.click();
  };
  const inReview = (phase === 'review' || phase === 'confirming') && !!parsed;

  return (
    <Dialog
      open
      onClose={requestClose}
      title="Import a statement"
      className={s.importDialog}
      dismissOnScrim={!busy}
      footNote={
        inReview ? (
          <span className={s.footNote}>
            Imported lines land in the bank feed as Pending and go through the same AI coding and reconciliation as a live
            feed. Negative = money out (debit or card charge); positive = money in.
          </span>
        ) : undefined
      }
      actions={
        <>
          <Button variant="quiet" onClick={requestClose} disabled={busy} chord="escape">
            Cancel
          </Button>
          {inReview && (
            <Button
              variant="primary"
              onClick={() => void confirmImport()}
              disabled={phase === 'confirming' || includedCount === 0}
              aria-busy={phase === 'confirming' || undefined}
            >
              {phase === 'confirming' ? 'Importing…' : `Import ${includedCount} transaction${includedCount === 1 ? '' : 's'}`}
            </Button>
          )}
        </>
      }
    >
      <p className={s.lede}>
        For manual accounts without a Plaid feed. Drop a bank or credit-card statement (PDF or image); AI reads the
        transactions and you review them. Nothing is imported until you confirm.
      </p>

      <div className={s.stack}>
        {error && (
          <InlineNotice tone="neg" title="That statement wasn’t read.">
            {error}
          </InlineNotice>
        )}

        {/* ── Select account + upload ─────────────────────────────────── */}
        {(phase === 'select' || phase === 'parsing') && (
          <>
            {acctLoading ? (
              <div className="wg-loading" aria-busy="true">
                <span className="bar-l" style={{ width: 320 }} aria-hidden="true" />
                <span className="t-cap" role="status">Loading accounts…</span>
              </div>
            ) : accounts.length === 0 ? (
              <InlineNotice title="No bank accounts yet.">Add a bank or card account first, then import its statement here.</InlineNotice>
            ) : (
              <Field label="Target account" id="statement-target-account" className={s.acctField} help="Only manual accounts can take a statement import.">
                <Select
                  value={accountId}
                  onChange={(e) => { setAccountId(e.target.value); setError(null); }}
                  disabled={phase === 'parsing'}
                  data-autofocus
                >
                  <option value="">Select an account…</option>
                  {manualAccounts.length > 0 && (
                    <optgroup label="Manual (importable)">
                      {manualAccounts.map((a) => (
                        <option key={a.id} value={a.id}>
                          {acctLabel(a)} · {a.locationName}
                        </option>
                      ))}
                    </optgroup>
                  )}
                  {accounts.some((a) => a.plaidLinked) && (
                    <optgroup label="Plaid-linked (live feed — not importable)">
                      {accounts.filter((a) => a.plaidLinked).map((a) => (
                        <option key={a.id} value={a.id}>
                          {acctLabel(a)} · {a.locationName}
                        </option>
                      ))}
                    </optgroup>
                  )}
                </Select>
              </Field>
            )}

            {isPlaid && (
              <InlineNotice tone="warn" icon={<Icon name="plug" />} title="This account has a live Plaid feed.">
                The feed is the source of truth. Statement import is only for manual (non-Plaid) accounts.
              </InlineNotice>
            )}

            <div
              role="button"
              tabIndex={canUpload && phase === 'select' ? 0 : -1}
              aria-disabled={!canUpload || phase !== 'select'}
              aria-label={canUpload ? 'Choose a statement file to upload' : 'Select an importable account to upload a statement'}
              data-state={dropState}
              className={s.drop}
              onDragOver={(e) => { e.preventDefault(); if (canUpload) setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={onDrop}
              onClick={openPicker}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  openPicker();
                }
              }}
            >
              <input
                ref={fileInput}
                type="file"
                accept=".pdf,image/*"
                className={s.hiddenInput}
                onChange={(e) => { const f = e.target.files?.[0]; if (f) void parse(f); e.target.value = ''; }}
              />
              {phase === 'parsing' ? (
                <div className="wg-loading" aria-busy="true">
                  <span className={`bar-l ${s.busyBar}`} aria-hidden="true" />
                  <span className="t-head" role="status">Reading the statement and pulling out transactions…</span>
                  <span className="t-cap">A long statement can take 15–30 seconds.</span>
                </div>
              ) : (
                <>
                  <span className={s.dropMark} aria-hidden="true">
                    <Icon name="upload" />
                  </span>
                  <span className="t-head">
                    {canUpload ? 'Drop a bank or credit-card statement here' : 'Select an importable account to continue'}
                  </span>
                  <span className="t-cap">or click to browse · PDF, PNG, JPEG · up to 15 MB</span>
                </>
              )}
            </div>
          </>
        )}

        {/* ── Review ──────────────────────────────────────────────────── */}
        {inReview && parsed && (
          <>
            <div className={s.reviewHead}>
              <span className="t-cap">
                <span className="ink">{parsed.meta.fileName}</span>
                {' · '}
                {acctLabel(parsed.account)}
                {(parsed.statement.periodStart || parsed.statement.periodEnd) && (
                  <span className="tnum">
                    {' · '}
                    {parsed.statement.periodStart ?? '?'} → {parsed.statement.periodEnd ?? '?'}
                  </span>
                )}
              </span>
              <span className="t-cap tnum">
                {includedCount} of {rows.length} line{rows.length === 1 ? '' : 's'} selected
              </span>
            </div>

            {/* Balance tie-out */}
            {checkable ? (
              <InlineNotice tone={tied ? 'default' : 'warn'}>
                <span className={s.tie}>
                  <span>
                    <b>{tied ? 'Balances tie out.' : 'Balances don’t tie.'}</b>{' '}
                    {tied
                      ? 'Opening + selected lines = closing.'
                      : 'The selected lines don’t add up to the statement’s change in balance.'}
                  </span>
                  <span className={`${s.tieFigs} tnum`}>
                    <span>Open {formatMoney(parsed.statement.openingCents ?? 0)}</span>
                    <span>Close {formatMoney(parsed.statement.closingCents ?? 0)}</span>
                    {!tied && liveDiff != null && <b>Off by {formatMoney(Math.abs(liveDiff))}</b>}
                  </span>
                </span>
              </InlineNotice>
            ) : (
              <InlineNotice title="No tie-out possible.">
                The statement doesn’t state both an opening and a closing balance. Review the lines carefully.
              </InlineNotice>
            )}

            {parsed.statement.documentNote && <InlineNotice>{parsed.statement.documentNote}</InlineNotice>}

            {duplicateCount > 0 && (
              <InlineNotice tone="info">
                <span className={s.tie}>
                  <span>
                    <b className="tnum">
                      {duplicateCount} line{duplicateCount === 1 ? '' : 's'} already in this account
                    </b>{' '}
                    (same date, amount and description).
                  </span>
                  <Button variant="quiet" onClick={excludeDuplicates}>
                    Exclude all duplicates
                  </Button>
                </span>
              </InlineNotice>
            )}

            {rows.length === 0 ? (
              <div className="wg-state">
                <span className="wg-empty-mark" aria-hidden="true">
                  <Icon name="file-text" />
                </span>
                <span className="t-head">No transactions were found in this statement.</span>
                <p>Check it’s the right file, or try a clearer scan.</p>
              </div>
            ) : (
              <div className={s.tableWrap}>
                <table className="tbl tbl-q tbl-q--compact tbl-q--flush" aria-label="Statement lines to import">
                  <colgroup>
                    <col style={{ width: 48 }} />
                    <col style={{ width: 168 }} />
                    <col />
                    <col style={{ width: 160 }} />
                    <col style={{ width: 56 }} />
                  </colgroup>
                  <thead>
                    <tr>
                      <th>
                        <Check
                          aria-label="Include all lines"
                          checked={allIncluded}
                          indeterminate={someIncluded}
                          onChange={(e) => setAllIncluded(e.target.checked)}
                        />
                      </th>
                      <th>Date</th>
                      <th>Description</th>
                      <th className="n">Amount</th>
                      <th><span className="sr">Remove</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr
                        key={r._id}
                        className={[!r.include && s.excluded, r.lowConfidence && s.lowConf].filter(Boolean).join(' ') || undefined}
                      >
                        <td>
                          <Check
                            checked={r.include}
                            onChange={(e) => setRow(r._id, 'include', e.target.checked)}
                            aria-label="Include line"
                          />
                        </td>
                        <td>
                          <Input
                            type="date"
                            className="tnum"
                            invalid={r.transaction_date == null}
                            value={r.transaction_date ?? ''}
                            onChange={(e) => setRow(r._id, 'transaction_date', e.target.value || null)}
                            aria-label="Date"
                          />
                        </td>
                        <td>
                          <div className={s.descCell}>
                            <Input
                              value={r.description}
                              onChange={(e) => setRow(r._id, 'description', e.target.value)}
                              placeholder="Description"
                              aria-label="Description"
                            />
                            {r.duplicate && (
                              <Tag title="Already exists in this account">Duplicate</Tag>
                            )}
                            {r.lowConfidence && (
                              <Tag tone="warn" title="The AI was unsure about this line — check it against the statement">
                                Check
                              </Tag>
                            )}
                          </div>
                        </td>
                        <td>
                          <Input
                            type="number"
                            step="0.01"
                            className="input--money"
                            invalid={r.amount_cents == null}
                            value={r.amount_cents == null ? '' : centsToDollars(r.amount_cents)}
                            onChange={(e) =>
                              setRow(r._id, 'amount_cents', e.target.value === '' ? null : Math.round(Number(e.target.value) * 100))
                            }
                            placeholder="0.00"
                            aria-label="Amount"
                            title="Negative = money out (debit / charge); positive = money in"
                          />
                        </td>
                        <td className="n">
                          <Button variant="quiet" iconOnly icon="x" onClick={() => removeRow(r._id)} aria-label="Remove line" title="Remove" />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </div>
    </Dialog>
  );
}
