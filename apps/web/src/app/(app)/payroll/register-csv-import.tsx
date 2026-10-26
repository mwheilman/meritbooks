'use client';

/**
 * Import a payroll register from a SPREADSHEET (CSV / XLSX) — the DETERMINISTIC,
 * no-AI complement to the drop-and-parse AI path (`register-import.tsx`).
 *
 * Flow: drop a CSV/XLSX register exported from ADP / Gusto / QuickBooks Payroll /
 * Paychex (or any spreadsheet) → we auto-detect the header row and MAP each column
 * to a payroll field (gross wages, each withholding, employer taxes, deductions, net
 * pay) → the reviewer adjusts the mapping with a LIVE preview and can save it as a
 * reusable per-provider template → we build the BALANCED payroll JE (DR gross wages +
 * DR employer taxes → CR net-pay clearing + CR each tax/withholding liability),
 * addressed by account role → the reviewer picks the company + confirms → it posts to
 * the GL through the SAME gated confirm route the AI path uses (`postJournalEntry` /
 * `check_journal_balance()`).
 *
 * No model is ever called. Nothing is written until the human confirms a balanced
 * entry, and the confirm route re-validates the balance server-side.
 */

import { useState, useRef, useEffect, useMemo } from 'react';
import { Button, ConfirmDialog, Dialog, Field, Icon, InlineNotice, Input, Select, Tag, cx } from '@meritbooks/merit-ui';
import { formatMoney, dollarsToCents, centsToDollars } from '@meritbooks/shared';
import { useQuery, addToast } from '@/hooks';
import { api } from '@/lib/api-client';
import {
  guessMapping, aggregateRows, applySavedMapping, headerSignature,
  TARGET_LABELS, MONEY_TARGETS,
  type ColumnMapping, type PayrollFieldTarget, type SavedMappingColumn,
} from '@/lib/payroll/register-csv';
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

// ── Types ─────────────────────────────────────────────────────────────────────
interface ParseResponse {
  fileName: string;
  headers: string[];
  rows: string[][];
  rowCount: number;
  truncated: boolean;
  mapping: ColumnMapping[];
}
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
interface BuildResponse {
  register: { payDate: string | null; periodStart: string | null; periodEnd: string | null; employeeCount: number | null; grossCents: number; netCents: number; lowConfidenceFields: string[] };
  lines: ProposedLine[];
  balance: { totalDebitCents: number; totalCreditCents: number; balanced: boolean; imbalanceCents: number; registerFoots: boolean; footingDeltaCents: number };
  unresolvedRoles: string[];
}
interface SavedMapping { id: string; providerName: string; mapping: SavedMappingColumn[]; headerSignature: string | null; updatedAt: string }
interface LocationOption { id: string; name: string; short_code: string }

const MAX_BYTES = 10 * 1024 * 1024;
const ACCEPT = '.csv,.tsv,.txt,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const todayIso = () => new Date().toISOString().slice(0, 10);
const centsToInput = (c: number) => centsToDollars(c).toFixed(2);
const inputToCents = (s: string) => dollarsToCents(Number(String(s).replace(/[$,\s]/g, '')) || 0);

// The order the target dropdown lists options in.
const TARGET_ORDER: PayrollFieldTarget[] = [
  'ignore', 'employee', 'gross', 'fed_wh', 'state_wh', 'local_wh',
  'fica_ss', 'fica_medicare', 'fica', 'net', 'employer_tax', 'deduction',
];

/** A money cell that has text but isn't a number (so it silently sums as 0). */
function unreadableMoney(raw: string | undefined): boolean {
  const t = (raw ?? '').trim();
  if (t === '') return false;
  const cleaned = t.replace(/^\((.*)\)$/, '$1').replace(/^-/, '').replace(/[$,\s]/g, '');
  return cleaned !== '' && !/^\d*\.?\d*$/.test(cleaned);
}

interface RowIssue { row: number; who: string; issue: string }

// ── Review line draft (post stage) ──────────────────────────────────────────────
interface LineDraft {
  key: string; roleKey: string; side: 'DR' | 'CR'; label: string; amountInput: string;
  accountId: string; degraded: boolean; suggestedAccountId: string | null;
}

const STEP_LABELS = ['Map columns', 'Review & post'] as const;

// ── Main dialog ──────────────────────────────────────────────────────────────
export function ImportRegisterCsv({ open, onClose, onPosted }: { open: boolean; onClose: () => void; onPosted: () => void }) {
  const [phase, setPhase] = useState<'idle' | 'parsing' | 'map' | 'building' | 'review' | 'error' | 'done'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Parsed file + mapping
  const [fileName, setFileName] = useState<string | null>(null);
  const [headers, setHeaders] = useState<string[]>([]);
  const [rows, setRows] = useState<string[][]>([]);
  const [truncated, setTruncated] = useState(false);
  const [mapping, setMapping] = useState<ColumnMapping[]>([]);
  const [payDate, setPayDate] = useState(todayIso());
  const [periodStart, setPeriodStart] = useState('');
  const [periodEnd, setPeriodEnd] = useState('');

  // Save-mapping controls
  const [providerName, setProviderName] = useState('');
  const [savingMapping, setSavingMapping] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<{ id: string; name: string } | null>(null);

  // Review (post) stage
  const [drafts, setDrafts] = useState<LineDraft[]>([]);
  const [locationId, setLocationId] = useState('');
  const [memo, setMemo] = useState('');
  const [unresolvedRoles, setUnresolvedRoles] = useState<string[]>([]);
  const [registerFoots, setRegisterFoots] = useState(true);
  const [footingDelta, setFootingDelta] = useState(0);
  const [reg, setReg] = useState<BuildResponse['register'] | null>(null);
  const [postedEntryNumber, setPostedEntryNumber] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [accounts, setAccounts] = useState<AccountOption[]>([]);
  const [loadingAccts, setLoadingAccts] = useState(false);

  const { data: locData } = useQuery<LocationOption[]>(open ? '/api/locations' : null);
  const locations = useMemo(() => locData ?? [], [locData]);
  const { data: savedData, refetch: refetchSaved } = useQuery<{ mappings: SavedMapping[] }>(open ? '/api/payroll/register-mappings' : null);
  const savedMappings = useMemo(() => savedData?.mappings ?? [], [savedData]);

  // Reset on close
  useEffect(() => {
    if (!open) {
      setPhase('idle'); setError(null); setFileName(null); setHeaders([]); setRows([]); setTruncated(false);
      setMapping([]); setPayDate(todayIso()); setPeriodStart(''); setPeriodEnd(''); setProviderName('');
      setDrafts([]); setLocationId(''); setMemo(''); setUnresolvedRoles([]); setRegisterFoots(true);
      setFootingDelta(0); setReg(null); setPostedEntryNumber(null); setSaving(false); setAccounts([]);
    }
  }, [open]);

  // Load company chart in the review stage; default each line to its suggested account.
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
            ? { ...ln, accountId: ln.suggestedAccountId } : ln
        )));
      })
      .catch(() => alive && setAccounts([]))
      .finally(() => alive && setLoadingAccts(false));
    return () => { alive = false; };
  }, [locationId]);

  const usableAccounts = useMemo(() => accounts.filter((a) => a.isActive && a.approvalStatus === 'APPROVED'), [accounts]);

  // Live preview aggregation (pure, client-side) as the mapping changes.
  const agg = useMemo(() => aggregateRows(rows, mapping), [rows, mapping]);
  const employerTaxTotal = useMemo(() => agg.employerTaxes.reduce((s, t) => s + t.cents, 0), [agg]);
  const withheldTotal = useMemo(
    () => agg.federalWithholdingCents + agg.stateWithholdingCents + agg.localWithholdingCents + agg.ficaEmployeeCents + agg.deductions.reduce((s, d) => s + d.cents, 0),
    [agg],
  );
  const hasGross = agg.grossCents > 0;
  const hasNet = agg.netCents > 0;

  // Rows to check: a mapped money cell we can't read (it would sum as 0), or — when
  // both gross and net are mapped — a row whose own arithmetic doesn't foot. The
  // same pure aggregation the totals use, one row at a time; nothing is changed.
  const rowIssues = useMemo<RowIssue[]>(() => {
    if (rows.length === 0) return [];
    const moneyCols = mapping.filter((m) => MONEY_TARGETS.has(m.target));
    const employeeCol = mapping.find((m) => m.target === 'employee');
    const footable = mapping.some((m) => m.target === 'gross') && mapping.some((m) => m.target === 'net');
    const out: RowIssue[] = [];
    rows.forEach((r, i) => {
      const who = employeeCol ? (r[employeeCol.index] ?? '').trim() : '';
      const bad = moneyCols.filter((m) => unreadableMoney(r[m.index]));
      if (bad.length > 0) {
        out.push({ row: i + 1, who, issue: `Can’t read ${bad.map((m) => m.header || `column ${m.index + 1}`).join(', ')}` });
        return;
      }
      if (footable) {
        const one = aggregateRows([r], mapping);
        if (one.grossCents !== 0 && one.footingDeltaCents !== 0) {
          out.push({ row: i + 1, who, issue: `Off by ${formatMoney(Math.abs(one.footingDeltaCents))}` });
        }
      }
    });
    return out;
  }, [rows, mapping]);

  if (!open) return null;

  // ── File handling ──────────────────────────────────────────────────────────
  const handleFile = async (file: File) => {
    setError(null);
    if (file.size > MAX_BYTES) { setError('File too large. Maximum 10MB.'); setPhase('error'); return; }
    setFileName(file.name);
    setPhase('parsing');
    const form = new FormData();
    form.append('file', file);
    const res = await fetch('/api/payroll/import-register/csv/parse', { method: 'POST', body: form });
    let body: ParseResponse & { error?: string };
    try { body = await res.json(); } catch { setError('The server returned an unreadable response.'); setPhase('error'); return; }
    if (!res.ok) { setError(body.error || 'Failed to read the file.'); setPhase('error'); return; }

    setHeaders(body.headers);
    setRows(body.rows);
    setTruncated(body.truncated);

    // Auto-apply a saved template whose header signature matches; else use the guess.
    const sig = headerSignature(body.headers);
    const match = savedMappings.find((m) => m.headerSignature && m.headerSignature === sig);
    if (match) {
      setMapping(applySavedMapping(body.headers, match.mapping));
      setProviderName(match.providerName);
      addToast('info', `Applied saved mapping "${match.providerName}"`);
    } else {
      setMapping(body.mapping.length ? body.mapping : guessMapping(body.headers));
    }
    setPhase('map');
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault(); setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) void handleFile(file);
  };

  const setColTarget = (index: number, target: PayrollFieldTarget) =>
    setMapping((prev) => prev.map((m) => (m.index === index ? { ...m, target, label: undefined } : m)));
  const setColLabel = (index: number, label: string) =>
    setMapping((prev) => prev.map((m) => (m.index === index ? { ...m, label } : m)));

  const applySaved = (id: string) => {
    const m = savedMappings.find((x) => x.id === id);
    if (!m) return;
    setMapping(applySavedMapping(headers, m.mapping));
    setProviderName(m.providerName);
    addToast('info', `Applied mapping "${m.providerName}"`);
  };

  const saveMapping = async () => {
    if (!providerName.trim()) { addToast('error', 'Name this mapping (e.g. your processor) before saving'); return; }
    setSavingMapping(true);
    const res = await api.post<{ ok: boolean; id: string }>('/api/payroll/register-mappings', {
      providerName: providerName.trim(),
      mapping: mapping.map((m) => ({ header: m.header, target: m.target, label: m.label })),
      headerSignature: headerSignature(headers),
    });
    setSavingMapping(false);
    if (res.error) { addToast('error', res.error.error); return; }
    addToast('success', `Saved mapping "${providerName.trim()}"`);
    refetchSaved();
  };

  const deleteSaved = async (id: string, name: string) => {
    const res = await api.delete<{ ok: boolean }>(`/api/payroll/register-mappings?id=${id}`);
    if (res.error) { addToast('error', res.error.error); return; }
    addToast('success', `Deleted mapping "${name}"`);
    refetchSaved();
  };

  // ── Build the balanced entry (deterministic, server-side aggregation) ────────
  const buildEntry = async () => {
    setError(null);
    setPhase('building');
    const res = await api.post<BuildResponse>('/api/payroll/import-register/csv/build', {
      rows, mapping,
      payDate: payDate || null,
      periodStart: periodStart || null,
      periodEnd: periodEnd || null,
    });
    if (res.error) { setError(res.error.error); setPhase('map'); addToast('error', res.error.error); return; }
    const b = res.data!;
    setReg(b.register);
    setUnresolvedRoles(b.unresolvedRoles ?? []);
    setRegisterFoots(b.balance.registerFoots);
    setFootingDelta(b.balance.footingDeltaCents);
    setMemo(`Payroll register (spreadsheet) — pay date ${b.register.payDate ?? payDate}`.trim());
    setDrafts(b.lines.map((l, i) => ({
      key: `${i}-${l.roleKey}-${l.side}`,
      roleKey: l.roleKey, side: l.side, label: l.label,
      amountInput: centsToInput(l.cents), accountId: '',
      degraded: l.degraded, suggestedAccountId: l.suggestedAccountId,
    })));
    setPhase('review');
  };

  const patchLine = (key: string, patch: Partial<LineDraft>) =>
    setDrafts((prev) => prev.map((d) => (d.key === key ? { ...d, ...patch } : d)));

  // Live balance from editable review drafts.
  const totalDebits = drafts.filter((d) => d.side === 'DR').reduce((s, d) => s + inputToCents(d.amountInput), 0);
  const totalCredits = drafts.filter((d) => d.side === 'CR').reduce((s, d) => s + inputToCents(d.amountInput), 0);
  const imbalance = totalDebits - totalCredits;
  const balanced = imbalance === 0 && totalDebits > 0;
  const allAccountsPicked = drafts.every((d) => inputToCents(d.amountInput) === 0 || !!d.accountId);
  const canPost = !saving && balanced && allAccountsPicked && !!locationId && !!payDate && drafts.length >= 2;

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
    const lines = drafts.filter((d) => inputToCents(d.amountInput) > 0).map((d) => ({
      accountId: d.accountId,
      debitCents: d.side === 'DR' ? inputToCents(d.amountInput) : 0,
      creditCents: d.side === 'CR' ? inputToCents(d.amountInput) : 0,
      memo: d.label,
    }));
    const res = await api.post<{ ok: boolean; entryNumber: string; alreadyPosted: boolean }>(
      '/api/payroll/import-register/confirm',
      { locationId, payDate, memo, lines },
    );
    if (res.error) { setSaving(false); addToast('error', res.error.error); return; }
    setPostedEntryNumber(res.data?.entryNumber ?? null);
    setSaving(false);
    setPhase('done');
    addToast('success', res.data?.alreadyPosted ? 'Payroll register already posted' : 'Payroll register posted to the ledger');
    onPosted();
  };

  // Can we build? Need at least a gross column that sums > 0.
  const canBuild = hasGross;

  const stepIndex = phase === 'map' || phase === 'building' ? 0 : phase === 'review' ? 1 : -1;

  const actions =
    phase === 'map' ? (
      <>
        {!canBuild && <span className="t-cap">Map a gross wages column first.</span>}
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" iconAfter="right" onClick={() => void buildEntry()} disabled={!canBuild}>
          Build balanced entry
        </Button>
      </>
    ) : phase === 'review' ? (
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

  const footNote =
    phase === 'map' ? (
      <Button variant="quiet" icon="left" onClick={() => { setPhase('idle'); }}>Upload a different file</Button>
    ) : phase === 'review' ? (
      <Button variant="quiet" icon="left" onClick={() => setPhase('map')} disabled={saving}>Back to column mapping</Button>
    ) : (
      'No AI reads this file. Nothing posts until you confirm a balanced entry.'
    );

  return (
    <Dialog
      open={open}
      onClose={() => { if (!saving) onClose(); }}
      title={
        <span className={s.dialogTitle}>
          Import a register from a spreadsheet
        </span>
      }
      width={960}
      className={s.tallDialog}
      dismissOnScrim={phase === 'idle' || phase === 'error' || phase === 'done'}
      footNote={footNote}
      actions={actions}
    >
      <div className={s.body}>
        {stepIndex >= 0 && (
          <div className={s.steps} aria-label="Import steps">
            {STEP_LABELS.map((label, i) => (
              <span
                key={label}
                className={cx(s.step, i === stepIndex && s.stepOn, i < stepIndex && s.stepDone)}
                aria-current={i === stepIndex ? 'step' : undefined}
              >
                <span className={s.stepNo} aria-hidden="true">{i + 1}</span>
                {label}
              </span>
            ))}
          </div>
        )}

        {/* Idle: dropzone */}
        {phase === 'idle' && (
          <>
            <p className="ink-2">
              CSV or Excel from any processor. Map the columns once, save the mapping, and post a balanced payroll entry.
            </p>
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={onDrop}
              className={cx(s.drop, dragOver && s.dropOver)}
              aria-label="Choose a payroll register spreadsheet, or drop one here"
            >
              <span className={s.dropIcon} aria-hidden="true"><Icon name="file-text" /></span>
              <span className="t-head">Drop a payroll register spreadsheet, or browse</span>
              <span className="t-cap">CSV, TSV or XLSX · up to 10 MB · the first row must be column headers</span>
            </button>
            <input ref={inputRef} type="file" accept={ACCEPT} className={s.hidden}
              onChange={(e) => { const f = e.target.files?.[0]; if (f) void handleFile(f); e.target.value = ''; }} />
            <p className="t-cap">
              Export the payroll register from your processor or your own spreadsheet. Prefer a PDF? Close this and use
              Import register.
            </p>
            {savedMappings.length > 0 && (
              <p className="t-cap tnum">
                {savedMappings.length} saved column mapping{savedMappings.length === 1 ? '' : 's'}. We apply the matching
                one when you drop a file.
              </p>
            )}
          </>
        )}

        {(phase === 'parsing' || phase === 'building') && (
          <WorkingState
            title={phase === 'parsing' ? `Reading ${fileName ?? 'the file'}…` : 'Building the balanced payroll entry…'}
            detail={phase === 'parsing' ? 'Parsing rows and detecting the column mapping.' : 'Summing the mapped columns and resolving accounts.'}
          />
        )}

        {phase === 'error' && <ErrorState message={error} onRetry={() => { setPhase('idle'); setError(null); }} />}

        {phase === 'done' && (
          <DoneState entryNumber={postedEntryNumber} onAnother={() => { setPhase('idle'); setDrafts([]); setPostedEntryNumber(null); }} />
        )}

        {/* ── Stage: MAP ─────────────────────────────────────────────────────── */}
        {phase === 'map' && (
          <>
            <div className={s.footRow}>
              <div className={s.meta}>
                <Icon name="file-text" />
                <span className={s.metaStrong}>{fileName}</span>
                <span className="tnum">{rows.length} row{rows.length === 1 ? '' : 's'}{truncated ? ' (first 20,000)' : ''}</span>
                <span className="tnum">{headers.length} columns</span>
              </div>
              {savedMappings.length > 0 && (
                <Select
                  aria-label="Apply a saved mapping"
                  style={{ width: 220 }}
                  onChange={(e) => { if (e.target.value) applySaved(e.target.value); e.target.value = ''; }}
                  defaultValue=""
                >
                  <option value="">Apply a saved mapping…</option>
                  {savedMappings.map((m) => <option key={m.id} value={m.id}>{m.providerName}</option>)}
                </Select>
              )}
            </div>

            {error && (
              <InlineNotice tone="neg" title="We couldn’t build the entry.">
                {error}
              </InlineNotice>
            )}

            {/* Mapping table with a sample preview */}
            <div className={cx(s.lines, s.scrollLines)}>
              <table className="tbl tbl-q tbl-q--compact" aria-label="Column mapping">
                <colgroup>
                  <col style={{ width: 220 }} />
                  <col />
                  <col style={{ width: 280 }} />
                </colgroup>
                <thead>
                  <tr>
                    <th scope="col">Column</th>
                    <th scope="col">Sample values</th>
                    <th scope="col">Maps to</th>
                  </tr>
                </thead>
                <tbody>
                  {mapping.map((m) => {
                    const samples = rows.slice(0, 3).map((r) => r[m.index]).filter((v) => (v ?? '').trim() !== '');
                    const isLabelled = m.target === 'employer_tax' || m.target === 'deduction';
                    const colName = m.header || `Column ${m.index + 1}`;
                    return (
                      <tr key={m.index} className={cx('q-row', s.cellTop)}>
                        <td>
                          <span className="l1" style={{ whiteSpace: 'normal' }}>{colName}</span>
                        </td>
                        <td>
                          <span className={cx('tnum', s.samples)}>{samples.length ? samples.join(', ') : '—'}</span>
                        </td>
                        <td className={s.mapTarget}>
                          <Select
                            value={m.target}
                            aria-label={`Map ${colName} to`}
                            onChange={(e) => setColTarget(m.index, e.target.value as PayrollFieldTarget)}
                          >
                            {TARGET_ORDER.map((t) => <option key={t} value={t}>{TARGET_LABELS[t]}</option>)}
                          </Select>
                          {isLabelled && (
                            <Input
                              type="text"
                              value={m.label ?? m.header}
                              onChange={(e) => setColLabel(m.index, e.target.value)}
                              placeholder="Ledger line label"
                              aria-label={`Ledger line label for ${colName}`}
                            />
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Live preview */}
            <section>
              <div className={s.sectionHead}>
                <span className="eyebrow">Live preview<span className="sl">//</span>Mapped totals</span>
                {agg.employeeCount > 0 && <span className="t-cap tnum">{agg.employeeCount} employee{agg.employeeCount === 1 ? '' : 's'}</span>}
              </div>
              <div style={{ marginTop: 8 }}>
                <RegisterFigures gross={agg.grossCents} withheld={withheldTotal} employerTax={employerTaxTotal} net={agg.netCents} />
              </div>
            </section>

            {/* Footing / balance readiness */}
            {!hasGross ? (
              <InlineNotice title="Map a gross wages column">to build the entry.</InlineNotice>
            ) : agg.registerFoots ? (
              <InlineNotice tone="info" icon={<Icon name="check" />} title="The register foots.">
                Gross equals net plus withholdings and deductions, so the payroll entry will balance.
              </InlineNotice>
            ) : (
              <InlineNotice tone="warn" title={<>The register is off by <span className="tnum">{formatMoney(Math.abs(agg.footingDeltaCents))}</span>.</>}>
                Gross minus withholdings and deductions doesn&apos;t equal net. Check your column mapping
                {hasNet ? '.' : ' — no net pay column is mapped yet.'}
              </InlineNotice>
            )}

            {/* Rows to check */}
            {rowIssues.length > 0 && (
              <InlineNotice
                tone="warn"
                title={<><span className="tnum">{rowIssues.length}</span> row{rowIssues.length === 1 ? '' : 's'} to check.</>}
              >
                These rows have an amount we can&apos;t read (it counts as 0) or don&apos;t foot on their own. Totals rows
                and blank lines in the export are the usual cause. Row numbers count data rows under the header.
                <ul className={s.rowIssues} aria-label="Rows to check">
                  {rowIssues.slice(0, 50).map((ri) => (
                    <li key={ri.row}>
                      <span className="tnum">Row {ri.row}</span>
                      <span className="mb-trunc">{ri.who || '—'}</span>
                      <span className="tnum">{ri.issue}</span>
                    </li>
                  ))}
                </ul>
                {rowIssues.length > 50 && (
                  <span className="t-cap tnum">and {rowIssues.length - 50} more</span>
                )}
              </InlineNotice>
            )}

            {/* Period */}
            <div className={s.grid3}>
              <Field label="Pay date">
                <Input type="date" value={payDate} onChange={(e) => setPayDate(e.target.value)} />
              </Field>
              <Field label="Period start (optional)">
                <Input type="date" value={periodStart} onChange={(e) => setPeriodStart(e.target.value)} />
              </Field>
              <Field label="Period end (optional)">
                <Input type="date" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} />
              </Field>
            </div>

            {/* Save mapping */}
            <div className={s.saveRow}>
              <Field label="Save this mapping as" help="Reused when the same columns come in again.">
                <Input
                  type="text"
                  value={providerName}
                  onChange={(e) => setProviderName(e.target.value)}
                  placeholder="Your processor’s name"
                />
              </Field>
              <Button icon="check" onClick={() => void saveMapping()} disabled={savingMapping || !providerName.trim()} aria-busy={savingMapping || undefined}>
                {savingMapping ? 'Saving…' : 'Save mapping'}
              </Button>
              {savedMappings.length > 0 && (
                <div className={s.savedList} aria-label="Saved mappings">
                  {savedMappings.map((m) => (
                    <Tag key={m.id} className={s.savedTag}>
                      {m.providerName}
                      <button
                        type="button"
                        className="btn btn--quiet btn--icon"
                        style={{ width: 20, height: 20 }}
                        onClick={() => setConfirmDelete({ id: m.id, name: m.providerName })}
                        aria-label={`Delete saved mapping ${m.providerName}`}
                        title={`Delete ${m.providerName}`}
                      >
                        <Icon name="x" />
                      </button>
                    </Tag>
                  ))}
                </div>
              )}
            </div>
          </>
        )}

        {/* ── Stage: REVIEW (accounts + post) ─────────────────────────────────── */}
        {phase === 'review' && (
          <>
            {!registerFoots && (
              <InlineNotice tone="warn" title="The register doesn’t foot.">
                Gross minus withholdings and deductions is off from net pay by{' '}
                <b className="tnum">{formatMoney(Math.abs(footingDelta))}</b>. Review the amounts before posting.
              </InlineNotice>
            )}
            {unresolvedRoles.length > 0 && (
              <InlineNotice tone="warn" title="Some lines have no account role.">
                No role is mapped for {unresolvedRoles.join(', ')}. Choose an account for each line below, or map the role
                on the Account roles screen.
              </InlineNotice>
            )}

            {reg && (
              <section>
                <div className={s.sectionHead}>
                  <span className="eyebrow">Register totals</span>
                  <span className={s.meta}>
                    {reg.payDate && <span className="tnum">Pay date {reg.payDate}</span>}
                    {(reg.periodStart || reg.periodEnd) && <span className="tnum">Period {reg.periodStart ?? '—'} → {reg.periodEnd ?? '—'}</span>}
                    {typeof reg.employeeCount === 'number' && reg.employeeCount > 0 && <span className="tnum">{reg.employeeCount} employee{reg.employeeCount === 1 ? '' : 's'}</span>}
                  </span>
                </div>
                <p className="t-cap" style={{ marginTop: 8 }}>
                  Posts as: debit gross wages and employer taxes; credit net pay (to cash or in transit) and the tax and
                  deduction liabilities. Check the account on every line before posting.
                </p>
              </section>
            )}

            {/* Company + pay date */}
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

      <ConfirmDialog
        open={!!confirmDelete}
        onClose={() => setConfirmDelete(null)}
        onConfirm={async () => { if (confirmDelete) await deleteSaved(confirmDelete.id, confirmDelete.name); }}
        title="Delete this saved mapping?"
        confirmLabel={confirmDelete ? `Delete ${confirmDelete.name}` : 'Delete mapping'}
        tone="danger"
      >
        Files with these columns won&apos;t be mapped automatically any more. Registers already posted are not affected.
      </ConfirmDialog>
    </Dialog>
  );
}
