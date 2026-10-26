'use client';

/**
 * Import payroll register: DROP-AND-PARSE a payroll register into a payroll JE.
 *
 * This is the MANUAL-IMPORT path for tenants NOT on the embedded provider. Flow:
 * drop the payroll register PDF from an outside processor (ADP/Paychex/Gusto/QBO/
 * spreadsheet) → the AI (via the metered gateway) extracts the period totals and
 * PROPOSES a BALANCED payroll journal entry, each line addressed by role with a
 * suggested account → the human picks a company, reviews/adjusts every account +
 * amount, and confirms → the balanced entry posts to the GL.
 *
 * The model never writes anything: this UI only ever POSTs (a) the file to parse
 * and (b) an explicit, human-confirmed, balanced entry. Running payroll inside the
 * product (the embedded run wizard) stays the alternative for provider tenants.
 */

import { useState, useRef, useEffect, useMemo } from 'react';
import { Button, Dialog, Field, Icon, InlineNotice, Input, Select, Tag, cx } from '@meritbooks/merit-ui';
import { formatMoney, dollarsToCents, centsToDollars } from '@meritbooks/shared';
import { useQuery, addToast } from '@/hooks';
import { api } from '@/lib/api-client';
import {
  BalanceNotice,
  DoneState,
  ErrorState,
  JournalLinesTable,
  RegisterFigures,
  WorkingState,
  type AccountOption,
} from './register-review';
import s from './payroll.module.css';

// ── Types mirroring the parse API ────────────────────────────────────────────
interface ProposedLine {
  roleKey: string;
  side: 'DR' | 'CR';
  cents: number;
  label: string;
  degraded: boolean;
  suggestedAccountId: string | null;
  suggestedAccountNumber: string | null;
  unresolved: boolean;
}
interface ParseResponse {
  register: {
    payDate: string | null;
    periodStart: string | null;
    periodEnd: string | null;
    employeeCount: number | null;
    grossCents: number;
    netCents: number;
    lowConfidenceFields: string[];
  };
  lines: ProposedLine[];
  balance: {
    totalDebitCents: number;
    totalCreditCents: number;
    balanced: boolean;
    imbalanceCents: number;
    registerFoots: boolean;
    footingDeltaCents: number;
  };
  unresolvedRoles: string[];
  meta: { fileName: string; model: string; decisionId: string | null; documentNote: string | null; extractionMs: number };
}

interface LocationOption { id: string; name: string; short_code: string }

const MAX_BYTES = 10 * 1024 * 1024;
const ACCEPT = '.pdf,image/png,image/jpeg,image/webp';
const todayIso = () => new Date().toISOString().slice(0, 10);
const centsToInput = (c: number) => centsToDollars(c).toFixed(2);
const inputToCents = (s: string) => dollarsToCents(Number(String(s).replace(/[$,\s]/g, '')) || 0);

// ── Editable line-draft state ────────────────────────────────────────────────
interface LineDraft {
  key: string;
  roleKey: string;
  side: 'DR' | 'CR';
  label: string;
  amountInput: string;
  accountId: string;
  degraded: boolean;
  unresolved: boolean;
  suggestedAccountId: string | null;
}

// ── Main dialog ──────────────────────────────────────────────────────────────
export function ImportRegister({ open, onClose, onPosted }: { open: boolean; onClose: () => void; onPosted: () => void }) {
  const [phase, setPhase] = useState<'idle' | 'parsing' | 'review' | 'error' | 'done'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Parse result / editable drafts
  const [drafts, setDrafts] = useState<LineDraft[]>([]);
  const [locationId, setLocationId] = useState('');
  const [payDate, setPayDate] = useState('');
  const [memo, setMemo] = useState('');
  const [decisionId, setDecisionId] = useState<string | null>(null);
  const [docNote, setDocNote] = useState<string | null>(null);
  const [unresolvedRoles, setUnresolvedRoles] = useState<string[]>([]);
  const [registerFoots, setRegisterFoots] = useState(true);
  const [footingDelta, setFootingDelta] = useState(0);
  const [postedEntryNumber, setPostedEntryNumber] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // The extracted period totals (for the plain-English summary above the JE).
  const [reg, setReg] = useState<ParseResponse['register'] | null>(null);

  // Accounts for the chosen company
  const [accounts, setAccounts] = useState<AccountOption[]>([]);
  const [loadingAccts, setLoadingAccts] = useState(false);

  const { data: locData } = useQuery<LocationOption[]>(open ? '/api/locations' : null);
  const locations = useMemo(() => locData ?? [], [locData]);

  useEffect(() => {
    if (!open) {
      setPhase('idle'); setError(null); setFileName(null); setDrafts([]); setLocationId(''); setPayDate('');
      setMemo(''); setDecisionId(null); setDocNote(null); setUnresolvedRoles([]); setRegisterFoots(true);
      setFootingDelta(0); setPostedEntryNumber(null); setSaving(false); setAccounts([]); setReg(null);
    }
  }, [open]);

  // Load this company's approved chart when a company is chosen; default each line's
  // account to its suggested account (by role) when that account exists here.
  useEffect(() => {
    if (!locationId) { setAccounts([]); return; }
    let alive = true;
    setLoadingAccts(true);
    fetch(`/api/accounts?location_id=${locationId}`)
      .then((r) => (r.ok ? r.json() : { data: [] }))
      .then((d) => {
        if (!alive) return;
        const list = (d.data ?? []) as AccountOption[];
        setAccounts(list);
        const usableIds = new Set(list.filter((a) => a.isActive && a.approvalStatus === 'APPROVED').map((a) => a.id));
        setDrafts((prev) => prev.map((ln) => (
          !ln.accountId && ln.suggestedAccountId && usableIds.has(ln.suggestedAccountId)
            ? { ...ln, accountId: ln.suggestedAccountId }
            : ln
        )));
      })
      .catch(() => alive && setAccounts([]))
      .finally(() => alive && setLoadingAccts(false));
    return () => { alive = false; };
  }, [locationId]);

  const usableAccounts = useMemo(() => accounts.filter((a) => a.isActive && a.approvalStatus === 'APPROVED'), [accounts]);

  if (!open) return null;

  const handleFile = async (file: File) => {
    setError(null);
    if (file.size > MAX_BYTES) { setError('File too large. Maximum 10MB.'); setPhase('error'); return; }
    setFileName(file.name);
    setPhase('parsing');

    const form = new FormData();
    form.append('file', file);
    const res = await fetch('/api/payroll/import-register', { method: 'POST', body: form });
    let body: ParseResponse & { error?: string };
    try { body = await res.json(); } catch { setError('The server returned an unreadable response.'); setPhase('error'); return; }
    if (!res.ok) { setError(body.error || 'Failed to parse the payroll register.'); setPhase('error'); return; }

    setReg(body.register ?? null);
    setDecisionId(body.meta?.decisionId ?? null);
    setDocNote(body.meta?.documentNote ?? null);
    setUnresolvedRoles(body.unresolvedRoles ?? []);
    setRegisterFoots(body.balance?.registerFoots ?? true);
    setFootingDelta(body.balance?.footingDeltaCents ?? 0);
    setPayDate(body.register?.payDate ?? todayIso());
    setMemo(`Payroll register — pay date ${body.register?.payDate ?? ''}`.trim());
    setDrafts((body.lines ?? []).map((l, i) => ({
      key: `${i}-${l.roleKey}-${l.side}`,
      roleKey: l.roleKey,
      side: l.side,
      label: l.label,
      amountInput: centsToInput(l.cents),
      accountId: '',
      degraded: l.degraded,
      unresolved: l.unresolved,
      suggestedAccountId: l.suggestedAccountId,
    })));
    setPhase('review');
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault(); setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) void handleFile(file);
  };

  const patchLine = (key: string, patch: Partial<LineDraft>) =>
    setDrafts((prev) => prev.map((d) => (d.key === key ? { ...d, ...patch } : d)));

  // Live balance from the (editable) drafts.
  const totalDebits = drafts.filter((d) => d.side === 'DR').reduce((s, d) => s + inputToCents(d.amountInput), 0);
  const totalCredits = drafts.filter((d) => d.side === 'CR').reduce((s, d) => s + inputToCents(d.amountInput), 0);
  const imbalance = totalDebits - totalCredits;
  const balanced = imbalance === 0 && totalDebits > 0;
  const allAccountsPicked = drafts.every((d) => inputToCents(d.amountInput) === 0 || !!d.accountId);
  const canPost = !saving && balanced && allAccountsPicked && !!locationId && !!payDate && drafts.length >= 2;

  // Plain-English register summary, derived from the LIVE (editable) drafts so it
  // tracks any edits the reviewer makes. Gross wages and employer taxes are the
  // debit legs; net pay is the take-home credit; the employee side (withholdings +
  // deductions) is what gross exceeds net by.
  const sumByRole = (role: string, side: 'DR' | 'CR') =>
    drafts.filter((d) => d.roleKey === role && d.side === side).reduce((s, d) => s + inputToCents(d.amountInput), 0);
  const grossWagesCents = sumByRole('WAGES_EXPENSE', 'DR');
  const employerTaxCents = sumByRole('PAYROLL_TAX_EXPENSE', 'DR');
  const netPayCents = sumByRole('PAYMENTS_IN_TRANSIT', 'CR');
  const employeeWithheldCents = Math.max(0, grossWagesCents - netPayCents);
  const hasSummary = grossWagesCents > 0 || netPayCents > 0;

  // Why Post is disabled, in plain words (shown beside the button).
  const blocker = !locationId
    ? 'Choose a company.'
    : !payDate
    ? 'Enter a pay date.'
    : !balanced
    ? 'The entry must balance.'
    : !allAccountsPicked
    ? 'Choose an account for every line with an amount.'
    : null;

  const confirmPost = async () => {
    setSaving(true);
    const lines = drafts
      .filter((d) => inputToCents(d.amountInput) > 0)
      .map((d) => ({
        accountId: d.accountId,
        debitCents: d.side === 'DR' ? inputToCents(d.amountInput) : 0,
        creditCents: d.side === 'CR' ? inputToCents(d.amountInput) : 0,
        memo: d.label,
      }));
    const res = await api.post<{ ok: boolean; entryNumber: string; alreadyPosted: boolean }>(
      '/api/payroll/import-register/confirm',
      { locationId, payDate, memo, lines, decisionId },
    );
    if (res.error) { setSaving(false); addToast('error', res.error.error); return; }
    setPostedEntryNumber(res.data?.entryNumber ?? null);
    setSaving(false);
    setPhase('done');
    addToast('success', res.data?.alreadyPosted ? 'Payroll register already posted' : 'Payroll register posted to the ledger');
    onPosted();
  };

  const actions =
    phase === 'review' ? (
      <>
        {blocker && <span className="t-cap">{blocker}</span>}
        <Button onClick={onClose} disabled={saving}>Cancel</Button>
        <Button variant="primary" icon="check" onClick={() => void confirmPost()} disabled={!canPost} aria-busy={saving || undefined}>
          {saving ? 'Posting…' : 'Post payroll entry'}
        </Button>
      </>
    ) : phase === 'done' ? (
      <Button variant="primary" onClick={onClose}>Done</Button>
    ) : (
      <Button onClick={onClose}>{phase === 'error' ? 'Close' : 'Cancel'}</Button>
    );

  return (
    <Dialog
      open={open}
      onClose={() => { if (!saving) onClose(); }}
      title="Import a payroll register"
      width={880}
      className={s.tallDialog}
      dismissOnScrim={phase === 'idle' || phase === 'error' || phase === 'done'}
      footNote={
        phase === 'review' ? (
          <Button variant="quiet" icon="left" onClick={() => { setPhase('idle'); setDrafts([]); }} disabled={saving}>
            Upload a different register
          </Button>
        ) : (
          'The AI proposes. Nothing posts until you confirm a balanced entry.'
        )
      }
      actions={actions}
    >
      <div className={s.body}>
        {/* Idle: dropzone */}
        {phase === 'idle' && (
          <>
            <p className="ink-2">
              For payroll you ran at an outside processor. Drop the register and we propose a balanced payroll entry
              for you to review and confirm.
            </p>
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={onDrop}
              className={cx(s.drop, dragOver && s.dropOver)}
              aria-label="Choose a payroll register file, or drop one here"
            >
              <span className={s.dropIcon} aria-hidden="true"><Icon name="upload" /></span>
              <span className="t-head">Drop a payroll register here, or browse</span>
              <span className="t-cap">PDF, PNG, JPEG or WebP · up to 10 MB</span>
            </button>
            <input ref={inputRef} type="file" accept={ACCEPT} className={s.hidden}
              onChange={(e) => { const f = e.target.files?.[0]; if (f) void handleFile(f); e.target.value = ''; }} />
            <p className="t-cap">
              Running payroll in the app through a connected provider instead? Close this and use Run payroll.
            </p>
          </>
        )}

        {/* Parsing */}
        {phase === 'parsing' && (
          <WorkingState
            title={`Reading ${fileName ?? 'the register'}…`}
            detail="Extracting the period totals and proposing a balanced payroll entry."
          />
        )}

        {/* Error */}
        {phase === 'error' && <ErrorState message={error} onRetry={() => { setPhase('idle'); setError(null); }} />}

        {/* Done */}
        {phase === 'done' && (
          <DoneState entryNumber={postedEntryNumber} onAnother={() => { setPhase('idle'); setDrafts([]); setPostedEntryNumber(null); }} />
        )}

        {/* Review */}
        {phase === 'review' && (
          <>
            {fileName && (
              <div className={s.meta}>
                <Icon name="file-text" />
                <span className={s.metaStrong}>{fileName}</span>
                <Tag tone="ai">Proposed by AI</Tag>
              </div>
            )}
            {docNote && <InlineNotice>{docNote}</InlineNotice>}
            {!registerFoots && (
              <InlineNotice tone="warn" title="The register doesn’t foot.">
                Gross minus withholdings and deductions is off from net pay by{' '}
                <b className="tnum">{formatMoney(Math.abs(footingDelta))}</b>. Check the extracted amounts before posting.
              </InlineNotice>
            )}
            {unresolvedRoles.length > 0 && (
              <InlineNotice tone="warn" title="Some lines have no account role.">
                No role is mapped for {unresolvedRoles.join(', ')}. Choose an account for each line below, or map the role
                on the Account roles screen.
              </InlineNotice>
            )}

            {/* Extracted register summary — what we read, in plain English, and how
                it becomes the balanced entry below. */}
            {hasSummary && (
              <section>
                <div className={s.sectionHead}>
                  <span className="eyebrow">Register totals</span>
                  <span className={s.meta}>
                    {reg?.payDate && <span className="tnum">Pay date {reg.payDate}</span>}
                    {(reg?.periodStart || reg?.periodEnd) && (
                      <span className="tnum">Period {reg?.periodStart ?? '—'} → {reg?.periodEnd ?? '—'}</span>
                    )}
                    {typeof reg?.employeeCount === 'number' && reg.employeeCount > 0 && (
                      <span className="tnum">{reg.employeeCount} employee{reg.employeeCount === 1 ? '' : 's'}</span>
                    )}
                  </span>
                </div>
                <div style={{ marginTop: 8 }}>
                  <RegisterFigures gross={grossWagesCents} withheld={employeeWithheldCents} employerTax={employerTaxCents} net={netPayCents} />
                </div>
                <p className="t-cap" style={{ marginTop: 8 }}>
                  Posts as: debit gross wages and employer taxes; credit net pay (to cash or in transit) and the tax and
                  deduction liabilities. Check the account on every line before posting.
                </p>
              </section>
            )}

            {reg && reg.lowConfidenceFields.length > 0 && (
              <InlineNotice tone="warn" title="Double-check these fields.">
                The extraction was low-confidence on {reg.lowConfidenceFields.join(', ')}.
              </InlineNotice>
            )}

            {/* Header inputs */}
            <div className={s.grid2}>
              <Field label="Company">
                <Select value={locationId} onChange={(e) => setLocationId(e.target.value)}>
                  <option value="">Choose a company…</option>
                  {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                </Select>
              </Field>
              <Field label="Pay date">
                <Input type="date" value={payDate} onChange={(e) => setPayDate(e.target.value)} />
              </Field>
            </div>

            <JournalLinesTable
              drafts={drafts}
              accounts={usableAccounts}
              locationId={locationId}
              loadingAccounts={loadingAccts}
              totalDebits={totalDebits}
              totalCredits={totalCredits}
              amountCents={inputToCents}
              onPatch={patchLine}
            />

            <BalanceNotice totalDebits={totalDebits} totalCredits={totalCredits} />
          </>
        )}
      </div>
    </Dialog>
  );
}
