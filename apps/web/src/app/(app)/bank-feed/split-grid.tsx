'use client';

/**
 * Split grid (FPB-bank-feed-splits §4) — split one bank or card line into N lines by
 * amount or %, each with its own GL account, company, department, class, job + cost code
 * and memo. Built on merit-ui kit classes (no legacy utilities) so it reads the same
 * inside the bridged bank-feed panel and the credit-card drawer.
 *
 * Keyboard (focus inside the grid): Enter / ↓ next line · ↑ previous line ·
 * Alt+N add a line · Alt+Backspace remove the line · Alt+R fill the remaining amount.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { Button, Check, InlineNotice, Input, Kbd, MoneyInput, Seg, Select, Tag } from '@meritbooks/merit-ui';
import { formatMoney } from '@meritbooks/shared';
import { addToast, useDebounce, useQuery } from '@/hooks';
import { allocateByPercent, formatBp, parsePercentToBp, remainingCents, FULL_BP, MAX_SPLIT_LINES } from '@/lib/bank/splits/allocate';
import type { SplitStateResponse } from '@/lib/bank/splits/types';
import type { SplitLineInput } from '@/lib/validations/bank-splits';

export interface SplitGridTxn {
  id: string;
  amount_cents: number;
  status: string;
  /** The bank / card account's company. */
  location_id: string | null;
  vendor_id: string | null;
  vendor_name: string | null;
  description: string;
}

export interface AccountLite {
  id: string;
  account_number: string;
  name: string;
  account_type?: string;
}

export interface SplitGridProps {
  transaction: SplitGridTxn;
  /** Pre-fills line 1 (the AI / reviewer's current account). */
  seedAccount?: AccountLite | null;
  /** Payee + note typed in the panel; sent with Save & Approve. */
  vendorName?: string;
  notes?: string;
  /** Back to a single GL account. */
  onUnsplit: () => void;
  /** After a post or a draft save (refresh the feed / close the panel). */
  onDone: (result: { posted: boolean; entryNumber?: string }) => void;
}

interface CompanyOption {
  id: string;
  name: string;
  short_code?: string | null;
  require_department?: boolean;
  require_class?: boolean;
}
interface DeptOption { id: string; name: string; code: string; locationId: string | null }
interface ClassOption { id: string; name: string; code: string }
interface JobOption { id: string; job_number: string; name: string; status?: string }
interface CostCodeOption { id: string; code: string; name: string }

interface GridLine {
  key: string;
  amountCents: number | null;
  percentText: string;
  account: AccountLite | null;
  locationId: string;
  departmentId: string | null;
  classId: string | null;
  jobId: string | null;
  costCodeId: string | null;
  memo: string;
}

type Mode = 'amount' | 'percent';

let keySeq = 0;
const newKey = () => `l${++keySeq}`;

function blankLine(locationId: string, account: AccountLite | null = null): GridLine {
  return { key: newKey(), amountCents: null, percentText: '', account, locationId, departmentId: null, classId: null, jobId: null, costCodeId: null, memo: '' };
}

const S = {
  stack: { display: 'flex', flexDirection: 'column', gap: 12 } as CSSProperties,
  line: { border: '1px solid var(--line-2)', background: 'var(--white)', padding: 8, display: 'flex', flexDirection: 'column', gap: 6 } as CSSProperties,
  row1: { display: 'grid', gridTemplateColumns: '22px 112px 76px minmax(0,1fr) 128px 32px', gap: 6, alignItems: 'center' } as CSSProperties,
  row2: { display: 'grid', gridTemplateColumns: '22px repeat(4, minmax(0,1fr))', gap: 6, alignItems: 'center' } as CSSProperties,
  num: { fontVariantNumeric: 'tabular-nums', color: 'var(--ink-3)', textAlign: 'right' } as CSSProperties,
  meterTrack: { height: 4, background: 'var(--line)', position: 'relative', overflow: 'hidden' } as CSSProperties,
  issue: { color: 'var(--neg)', paddingLeft: 28 } as CSSProperties,
};

/** Live amounts per line for the current mode. */
function lineAmounts(lines: GridLine[], mode: Mode, total: number): number[] {
  if (mode === 'amount') return lines.map((l) => l.amountCents ?? 0);
  const bps = lines.map((l) => parsePercentToBp(l.percentText) ?? 0);
  return allocateByPercent(total, bps);
}

export function SplitGrid({ transaction, seedAccount, vendorName, notes, onUnsplit, onDone }: SplitGridProps) {
  const total = Math.abs(transaction.amount_cents);
  const homeCompany = transaction.location_id ?? '';

  const { data: state, isLoading: stateLoading, error: stateError, refetch: refetchState } = useQuery<SplitStateResponse>(
    '/api/bank-feed/splits', { transaction_id: transaction.id }, { scope: false },
  );
  const { data: companies } = useQuery<CompanyOption[]>('/api/locations', undefined, { scope: false });
  const { data: deptData } = useQuery<{ departments: DeptOption[] }>('/api/departments', undefined, { scope: false });
  const { data: classData } = useQuery<ClassOption[]>('/api/classes', undefined, { scope: false });
  const { data: costCodeData } = useQuery<{ cost_codes: CostCodeOption[] }>('/api/bank-feed/cost-codes', undefined, { scope: false });

  const [mode, setMode] = useState<Mode>('amount');
  const [lines, setLines] = useState<GridLine[]>(() => [blankLine(homeCompany, seedAccount ?? null), blankLine(homeCompany)]);
  const [hydrated, setHydrated] = useState(false);
  const [ruleId, setRuleId] = useState<string | null>(null);
  const [remember, setRemember] = useState(false);
  const [busy, setBusy] = useState<null | 'approve' | 'draft' | 'unsplit'>(null);
  const [companiesWithJobs, setCompaniesWithJobs] = useState<Record<string, boolean>>({});
  const amountRefs = useRef(new Map<string, HTMLInputElement>());
  const focusKey = useRef<string | null>(null);

  // Hydrate from a saved draft once.
  useEffect(() => {
    if (hydrated || !state) return;
    setHydrated(true);
    if (state.status === 'DRAFT' && state.lines.length > 0) {
      const allPct = state.lines.every((r) => r.percent_bp != null);
      setMode(allPct ? 'percent' : 'amount');
      setRuleId(state.lines[0].split_rule_id);
      setLines(state.lines.map((r) => ({
        key: newKey(),
        amountCents: r.amount_cents,
        percentText: r.percent_bp != null ? formatBp(r.percent_bp) : '',
        account: state.accounts[r.account_id] ?? { id: r.account_id, account_number: '', name: 'Account' },
        locationId: r.allocation_location_id,
        departmentId: r.department_id,
        classId: r.class_id,
        jobId: r.job_id,
        costCodeId: r.cost_code_id,
        memo: r.memo ?? '',
      })));
    }
  }, [state, hydrated]);

  const amounts = useMemo(() => lineAmounts(lines, mode, total), [lines, mode, total]);
  const remaining = remainingCents(total, amounts);
  const bpTotal = lines.reduce((s, l) => s + (parsePercentToBp(l.percentText) ?? 0), 0);
  const companyById = useMemo(() => new Map((companies ?? []).map((c) => [c.id, c])), [companies]);
  const crossCompany = lines.some((l) => l.locationId && l.locationId !== homeCompany);

  const issuesFor = useCallback((l: GridLine, amount: number): string[] => {
    const out: string[] = [];
    if (amount <= 0) out.push('Enter an amount');
    if (!l.account) out.push('Pick a GL account');
    const co = companyById.get(l.locationId);
    if (co?.require_department && !l.departmentId) out.push(`${co.short_code ?? co.name} requires a department`);
    if (co?.require_class && !l.classId) out.push(`${co.short_code ?? co.name} requires a class`);
    if (l.account?.account_type === 'COGS' && !l.jobId && companiesWithJobs[l.locationId]) out.push('COGS needs a job');
    return out;
  }, [companyById, companiesWithJobs]);

  const lineIssues = lines.map((l, i) => issuesFor(l, amounts[i] ?? 0));
  const ready = remaining === 0 && lineIssues.every((x) => x.length === 0) && (mode === 'amount' || bpTotal === FULL_BP);

  const patch = useCallback((key: string, p: Partial<GridLine>) => {
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...p } : l)));
  }, []);

  const addLine = useCallback(() => {
    if (lines.length >= MAX_SPLIT_LINES) {
      addToast('error', `A split can have at most ${MAX_SPLIT_LINES} lines`);
      return;
    }
    const nl = blankLine(homeCompany);
    focusKey.current = nl.key;
    setLines((ls) => [...ls, nl]);
  }, [homeCompany, lines.length]);

  const removeLine = useCallback((key: string) => {
    setLines((ls) => {
      if (ls.length <= 1) return ls;
      const idx = ls.findIndex((l) => l.key === key);
      const next = ls.filter((l) => l.key !== key);
      focusKey.current = next[Math.max(0, idx - 1)]?.key ?? null;
      return next;
    });
  }, []);

  const fillRemaining = useCallback((key: string) => {
    const idx = lines.findIndex((l) => l.key === key);
    if (idx < 0) return;
    if (mode === 'amount') {
      const others = amounts.reduce((s, a, i) => (i === idx ? s : s + a), 0);
      const fill = total - others;
      if (fill > 0) patch(key, { amountCents: fill });
    } else {
      const others = lines.reduce((s, l, i) => (i === idx ? s : s + (parsePercentToBp(l.percentText) ?? 0)), 0);
      const fill = FULL_BP - others;
      if (fill > 0) patch(key, { percentText: formatBp(fill) });
    }
  }, [amounts, lines, mode, patch, total]);

  // Move focus after add / remove.
  useEffect(() => {
    if (!focusKey.current) return;
    const el = amountRefs.current.get(focusKey.current);
    focusKey.current = null;
    el?.focus();
  }, [lines]);

  const focusLine = (idx: number) => {
    const l = lines[idx];
    if (l) amountRefs.current.get(l.key)?.focus();
  };

  const onGridKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const host = (e.target as HTMLElement).closest<HTMLElement>('[data-split-line]');
    const key = host?.dataset.splitLine ?? null;
    const idx = key ? lines.findIndex((l) => l.key === key) : -1;
    if (e.altKey && (e.key === 'n' || e.key === 'N' || e.code === 'KeyN')) {
      e.preventDefault();
      addLine();
    } else if (e.altKey && e.key === 'Backspace' && key) {
      e.preventDefault();
      removeLine(key);
    } else if (e.altKey && (e.key === 'r' || e.key === 'R' || e.code === 'KeyR') && key) {
      e.preventDefault();
      fillRemaining(key);
    } else if ((e.target as HTMLElement).dataset.splitAmount === '1' && idx >= 0) {
      if (e.key === 'Enter' || e.key === 'ArrowDown') {
        e.preventDefault();
        if (idx === lines.length - 1) {
          if (e.key === 'Enter' && remaining > 0) addLine();
        } else focusLine(idx + 1);
      } else if (e.key === 'ArrowUp' && idx > 0) {
        e.preventDefault();
        focusLine(idx - 1);
      }
    }
  };

  const applySuggestion = () => {
    const sug = state?.suggestion;
    if (!sug) return;
    setMode('percent');
    setRuleId(sug.rule_id);
    setLines(sug.lines.map((l) => ({
      key: newKey(),
      amountCents: l.amount_cents,
      percentText: formatBp(l.percent_bp),
      account: state?.accounts[l.account_id] ?? { id: l.account_id, account_number: '', name: 'Account' },
      locationId: l.allocation_location_id,
      departmentId: l.department_id ?? null,
      classId: l.class_id ?? null,
      jobId: l.job_id ?? null,
      costCodeId: l.cost_code_id ?? null,
      memo: l.memo ?? '',
    })));
  };

  const forgetRule = async (id: string) => {
    const res = await fetch('/api/bank-feed/split-rules', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, is_active: false }),
    });
    if (res.ok) {
      addToast('success', 'Split rule forgotten');
      if (ruleId === id) setRuleId(null);
      void refetchState();
    } else {
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      addToast('error', j.error ?? 'Could not forget the rule');
    }
  };

  const toInputs = (): SplitLineInput[] => lines.map((l, i) => ({
    amount_cents: amounts[i],
    percent_bp: mode === 'percent' ? parsePercentToBp(l.percentText) : null,
    account_id: (l.account as AccountLite).id,
    allocation_location_id: l.locationId || null,
    department_id: l.departmentId,
    class_id: l.classId,
    job_id: l.jobId,
    cost_code_id: l.jobId ? l.costCodeId : null,
    memo: l.memo.trim() || null,
  }));

  const approve = async () => {
    if (!ready) return;
    setBusy('approve');
    try {
      const res = await fetch('/api/bank-feed/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          transaction_id: transaction.id,
          splits: toInputs(),
          vendor_id: transaction.vendor_id ?? undefined,
          vendor_name: vendorName?.trim() || undefined,
          notes: notes?.trim() || undefined,
          remember_split: remember || undefined,
          split_rule_id: ruleId ?? undefined,
        }),
      });
      const j = (await res.json().catch(() => ({}))) as { success?: boolean; error?: string; entry_number?: string; remembered_rule?: { name: string } | null };
      if (res.ok && j.success) {
        addToast('success', `Split approved → ${j.entry_number ?? ''}${j.remembered_rule ? ` · remembered "${j.remembered_rule.name}"` : ''}`);
        onDone({ posted: true, entryNumber: j.entry_number });
      } else addToast('error', j.error ?? 'Could not approve the split');
    } catch {
      addToast('error', 'Network error while approving');
    } finally {
      setBusy(null);
    }
  };

  const saveDraft = async () => {
    if (!ready) return;
    setBusy('draft');
    try {
      const res = await fetch('/api/bank-feed/splits', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transaction_id: transaction.id, lines: toInputs(), split_rule_id: ruleId }),
      });
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      if (res.ok) {
        addToast('success', 'Split saved — approve it any time (batch approve uses it too)');
        onDone({ posted: false });
      } else addToast('error', j.error ?? 'Could not save the split');
    } finally {
      setBusy(null);
    }
  };

  const unsplit = async () => {
    if (state?.status === 'DRAFT') {
      setBusy('unsplit');
      try {
        const res = await fetch('/api/bank-feed/splits', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ transaction_id: transaction.id, lines: [] }),
        });
        if (!res.ok) {
          const j = (await res.json().catch(() => ({}))) as { error?: string };
          addToast('error', j.error ?? 'Could not remove the split');
          return;
        }
      } finally {
        setBusy(null);
      }
    }
    onUnsplit();
  };

  // ── render ─────────────────────────────────────────────────────────────────
  if (stateLoading && !state) {
    return <p className="t-cap" role="status">Loading the split…</p>;
  }
  if (stateError) {
    return (
      <InlineNotice tone="neg" title="The split could not load.">
        {stateError} <button type="button" className="link" onClick={() => void refetchState()}>Try again</button>
      </InlineNotice>
    );
  }
  if (state && !state.transaction.splittable) {
    return (
      <InlineNotice tone="warn" title="This line pays a bill.">
        It settles Accounts Payable, so it can't be split. Unmatch the bill to split it.{' '}
        <button type="button" className="link" onClick={onUnsplit}>Back</button>
      </InlineNotice>
    );
  }
  if (state?.status === 'POSTED') {
    return <PostedSplit state={state} companyById={companyById} />;
  }

  const pctAllocated = total > 0 ? Math.min(100, Math.max(0, ((total - Math.max(remaining, 0)) / total) * 100)) : 0;
  const meterColor = remaining === 0 ? 'var(--pos)' : remaining < 0 ? 'var(--neg)' : 'var(--electric)';

  return (
    <section style={S.stack} aria-label="Split transaction" onKeyDown={onGridKey}>
      <div className="row row--between">
        <span className="eyebrow">02 // Split</span>
        <Seg<Mode>
          aria-label="Split by"
          value={mode}
          onChange={(m) => {
            // Carry the current split across modes so nothing typed is lost.
            if (m === 'percent' && mode === 'amount') {
              setLines((ls) => ls.map((l, i) => ({ ...l, percentText: total > 0 && amounts[i] > 0 ? formatBp(Math.round((amounts[i] * FULL_BP) / total)) : '' })));
            } else if (m === 'amount' && mode === 'percent') {
              setLines((ls) => ls.map((l, i) => ({ ...l, amountCents: amounts[i] > 0 ? amounts[i] : null })));
            }
            setMode(m);
          }}
          items={[{ value: 'amount', label: '$ Amount' }, { value: 'percent', label: '% Percent' }]}
        />
      </div>

      {state?.suggestion && state.status === 'NONE' && (
        <InlineNotice tone="info" title={state.suggestion.source === 'RULE' ? `Saved split: ${state.suggestion.name}.` : `${state.suggestion.name}.`}>
          {state.suggestion.lines.length} lines, {state.suggestion.lines.map((l) => `${formatBp(l.percent_bp)}%`).join(' / ')}.{' '}
          <button type="button" className="link" onClick={applySuggestion}>Apply</button>
          {state.suggestion.source === 'RULE' && state.suggestion.rule_id && (
            <>
              {' · '}
              <button type="button" className="link" onClick={() => void forgetRule(state.suggestion?.rule_id as string)}>Forget rule</button>
            </>
          )}
        </InlineNotice>
      )}

      {/* Remaining-to-allocate meter */}
      <div aria-live="polite">
        <div className="row row--between">
          <span className="t-cap">
            {remaining === 0 ? 'Fully allocated' : remaining > 0 ? `Remaining ${formatMoney(remaining)} of ${formatMoney(total)}` : `Over by ${formatMoney(-remaining)}`}
          </span>
          <span className="t-cap tnum">
            {mode === 'percent' ? `${formatBp(bpTotal)}% of 100%` : `${formatMoney(total - remaining)} allocated`}
          </span>
        </div>
        <div style={S.meterTrack} role="progressbar" aria-label="Allocated" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pctAllocated)}>
          <div style={{ position: 'absolute', inset: 0, width: `${pctAllocated}%`, background: meterColor }} />
        </div>
      </div>

      {lines.map((l, i) => (
        <SplitLineEditor
          key={l.key}
          index={i}
          line={l}
          mode={mode}
          amount={amounts[i] ?? 0}
          vendorId={transaction.vendor_id}
          companies={companies ?? []}
          departments={deptData?.departments ?? []}
          classes={classData ?? []}
          costCodes={costCodeData?.cost_codes ?? []}
          issues={lineIssues[i]}
          showIssues={remaining === 0 || (amounts[i] ?? 0) > 0}
          canRemove={lines.length > 1}
          onPatch={(p) => patch(l.key, p)}
          onRemove={() => removeLine(l.key)}
          onJobsKnown={(locId, has) => setCompaniesWithJobs((m) => (m[locId] === has ? m : { ...m, [locId]: has }))}
          registerAmount={(el) => {
            if (el) amountRefs.current.set(l.key, el);
            else amountRefs.current.delete(l.key);
          }}
        />
      ))}

      <div className="row row--between">
        <Button variant="quiet" icon="plus" onClick={addLine} disabled={lines.length >= MAX_SPLIT_LINES}>
          Add line
        </Button>
        <span className="t-cap">
          <Kbd>Alt</Kbd>+<Kbd>N</Kbd> add · <Kbd>Alt</Kbd>+<Kbd>R</Kbd> fill remaining · <Kbd>↑</Kbd><Kbd>↓</Kbd> move
        </span>
      </div>

      {crossCompany && (
        <InlineNotice tone="info" title="Cross-company split.">
          Lines booked to another company post on that company&apos;s books, with the intercompany due-to / due-from pair on both sides.
        </InlineNotice>
      )}

      <Check
        checked={remember}
        onChange={(e) => setRemember(e.target.checked)}
        label={`Remember this split for ${transaction.vendor_name || vendorName || 'this description'}`}
      />

      <div className="btn-row" style={{ justifyContent: 'space-between' }}>
        <Button variant="quiet" onClick={() => void unsplit()} disabled={busy !== null}>
          {busy === 'unsplit' ? 'Removing…' : 'Unsplit'}
        </Button>
        <div className="btn-row">
          <Button onClick={() => void saveDraft()} disabled={!ready || busy !== null}>
            {busy === 'draft' ? 'Saving…' : 'Save split'}
          </Button>
          <Button variant="primary" icon="check" onClick={() => void approve()} disabled={!ready || busy !== null}>
            {busy === 'approve' ? 'Posting…' : 'Save & Approve'}
          </Button>
        </div>
      </div>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

interface LineEditorProps {
  index: number;
  line: GridLine;
  mode: Mode;
  amount: number;
  vendorId: string | null;
  companies: CompanyOption[];
  departments: DeptOption[];
  classes: ClassOption[];
  costCodes: CostCodeOption[];
  issues: string[];
  showIssues: boolean;
  canRemove: boolean;
  onPatch: (p: Partial<GridLine>) => void;
  onRemove: () => void;
  onJobsKnown: (locationId: string, hasJobs: boolean) => void;
  registerAmount: (el: HTMLInputElement | null) => void;
}

function SplitLineEditor(props: LineEditorProps) {
  const { index, line, mode, amount, vendorId, companies, departments, classes, costCodes, issues, showIssues, canRemove, onPatch, onRemove, onJobsKnown, registerAmount } = props;
  const n = index + 1;
  const { data: jobs } = useQuery<JobOption[]>('/api/jobs/search', line.locationId ? { location_id: line.locationId } : undefined, { enabled: !!line.locationId, scope: false });
  const hasJobs = (jobs ?? []).length > 0;
  useEffect(() => {
    if (jobs && line.locationId) onJobsKnown(line.locationId, hasJobs);
  }, [jobs, hasJobs, line.locationId, onJobsKnown]);

  const depts = departments.filter((d) => !d.locationId || d.locationId === line.locationId);

  return (
    <div style={S.line} data-split-line={line.key} role="group" aria-label={`Split line ${n}`}>
      <div style={S.row1}>
        <span className="t-cap tnum" style={S.num}>{n}</span>
        {mode === 'amount' ? (
          <MoneyInput
            ref={registerAmount}
            data-split-amount="1"
            aria-label={`Line ${n} amount`}
            valueCents={line.amountCents}
            onChangeCents={(c) => onPatch({ amountCents: c })}
            placeholder="0.00"
          />
        ) : (
          <Input
            ref={registerAmount}
            data-split-amount="1"
            aria-label={`Line ${n} percent`}
            inputMode="decimal"
            value={line.percentText}
            onChange={(e) => onPatch({ percentText: e.target.value })}
            placeholder="0.00%"
            invalid={line.percentText !== '' && parsePercentToBp(line.percentText) == null}
            style={{ textAlign: 'right' }}
          />
        )}
        <span className="t-cap tnum" style={S.num} aria-label={`Line ${n} ${mode === 'amount' ? 'percent' : 'amount'}`}>
          {mode === 'amount' ? '' : formatMoney(amount)}
        </span>
        <AccountPicker n={n} value={line.account} vendorId={vendorId} onChange={(a) => onPatch({ account: a })} />
        <Select
          aria-label={`Line ${n} company`}
          value={line.locationId}
          onChange={(e) => onPatch({ locationId: e.target.value, departmentId: null, jobId: null, costCodeId: null })}
        >
          {line.locationId === '' && <option value="">This company</option>}
          {companies.map((c) => (
            <option key={c.id} value={c.id}>{c.short_code ? `${c.short_code} · ${c.name}` : c.name}</option>
          ))}
        </Select>
        <Button variant="quiet" iconOnly icon="x" aria-label={`Remove line ${n}`} onClick={onRemove} disabled={!canRemove} />
      </div>
      <div style={S.row2}>
        <span />
        <Select aria-label={`Line ${n} department`} value={line.departmentId ?? ''} onChange={(e) => onPatch({ departmentId: e.target.value || null })}>
          <option value="">Department</option>
          {depts.map((d) => <option key={d.id} value={d.id}>{d.code} · {d.name}</option>)}
        </Select>
        <Select aria-label={`Line ${n} class`} value={line.classId ?? ''} onChange={(e) => onPatch({ classId: e.target.value || null })}>
          <option value="">Class</option>
          {classes.map((c) => <option key={c.id} value={c.id}>{c.code} · {c.name}</option>)}
        </Select>
        {hasJobs ? (
          <div style={{ display: 'grid', gridTemplateColumns: costCodes.length && line.jobId ? '1fr 1fr' : '1fr', gap: 6 }}>
            <Select aria-label={`Line ${n} job`} value={line.jobId ?? ''} onChange={(e) => onPatch({ jobId: e.target.value || null, costCodeId: null })}>
              <option value="">Job</option>
              {(jobs ?? []).map((j) => <option key={j.id} value={j.id}>{j.job_number} · {j.name}</option>)}
            </Select>
            {costCodes.length > 0 && line.jobId && (
              <Select aria-label={`Line ${n} cost code`} value={line.costCodeId ?? ''} onChange={(e) => onPatch({ costCodeId: e.target.value || null })}>
                <option value="">Cost code</option>
                {costCodes.map((c) => <option key={c.id} value={c.id}>{c.code} · {c.name}</option>)}
              </Select>
            )}
          </div>
        ) : (
          <span className="t-cap">No jobs</span>
        )}
        <Input aria-label={`Line ${n} memo`} value={line.memo} maxLength={500} placeholder="Memo" onChange={(e) => onPatch({ memo: e.target.value })} />
      </div>
      {issues.length > 0 && showIssues && (
        <span className="t-cap" style={S.issue}>{issues.join(' · ')}</span>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

interface AccountSearchResponse { recent: AccountLite[]; accounts: AccountLite[] }

/** GL account combobox: vendor recents first, then debounced search. */
function AccountPicker({ n, value, vendorId, onChange }: { n: number; value: AccountLite | null; vendorId: string | null; onChange: (a: AccountLite) => void }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const dq = useDebounce(q, 200);
  const boxRef = useRef<HTMLDivElement>(null);
  const params: Record<string, string> = {};
  if (dq) params.q = dq;
  if (vendorId) params.vendor_id = vendorId;
  const { data, isLoading } = useQuery<AccountSearchResponse>('/api/accounts/search', params, { enabled: open, scope: false });
  const options = useMemo(() => {
    const seen = new Set<string>();
    const out: Array<AccountLite & { recent: boolean }> = [];
    for (const a of data?.recent ?? []) if (!seen.has(a.id)) { seen.add(a.id); out.push({ ...a, recent: true }); }
    for (const a of data?.accounts ?? []) if (!seen.has(a.id)) { seen.add(a.id); out.push({ ...a, recent: false }); }
    return out.slice(0, 60);
  }, [data]);

  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => { if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);

  const choose = (a: AccountLite) => {
    onChange({ id: a.id, account_number: a.account_number, name: a.name, account_type: a.account_type });
    setOpen(false);
    setQ('');
  };
  const listId = `split-acct-${n}`;
  const label = value ? `${value.account_number ? `${value.account_number} · ` : ''}${value.name}` : '';

  return (
    <div ref={boxRef} style={{ position: 'relative' }}>
      <Input
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-label={`Line ${n} GL account`}
        placeholder="GL account"
        value={open ? q : label}
        onFocus={() => { setOpen(true); setActive(0); }}
        onChange={(e) => { setQ(e.target.value); setOpen(true); setActive(0); }}
        onKeyDown={(e) => {
          if (!open) return;
          if (e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); setActive((i) => Math.min(i + 1, options.length - 1)); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); setActive((i) => Math.max(i - 1, 0)); }
          else if (e.key === 'Enter' && options[active]) { e.preventDefault(); e.stopPropagation(); choose(options[active]); }
          else if (e.key === 'Escape') { e.preventDefault(); e.nativeEvent.stopImmediatePropagation(); e.stopPropagation(); setOpen(false); }
        }}
      />
      {open && (
        <div
          id={listId}
          role="listbox"
          style={{ position: 'absolute', zIndex: 20, top: 34, left: 0, right: 0, maxHeight: 260, overflowY: 'auto', background: 'var(--white)', border: '1px solid var(--line-2)', boxShadow: '0 8px 24px rgba(10,22,40,.12)' }}
        >
          {isLoading && !data && <div className="t-cap" style={{ padding: 8 }}>Searching…</div>}
          {data && options.length === 0 && <div className="t-cap" style={{ padding: 8 }}>No accounts found</div>}
          {options.map((a, i) => (
            <div
              key={a.id}
              role="option"
              aria-selected={i === active}
              onMouseDown={(e) => { e.preventDefault(); choose(a); }}
              onMouseEnter={() => setActive(i)}
              style={{ padding: '6px 8px', cursor: 'pointer', display: 'flex', gap: 8, alignItems: 'center', background: i === active ? 'var(--sky)' : undefined }}
            >
              <span className="tnum t-cap">{a.account_number}</span>
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.name}</span>
              {a.recent && <Tag tone="ai">Recent</Tag>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

function PostedSplit({ state, companyById }: { state: SplitStateResponse; companyById: Map<string, CompanyOption> }) {
  const companies = new Set(state.lines.map((l) => l.allocation_location_id)).size;
  return (
    <section style={S.stack} aria-label="Posted split">
      <div className="row row--between">
        <span className="eyebrow">02 // Split</span>
        <Tag tone="pos">Posted · {state.lines.length} lines{companies > 1 ? ` · ${companies} companies` : ''}</Tag>
      </div>
      <table className="tbl tbl-q tbl-q--compact tbl-q--flush">
        <thead>
          <tr><th>#</th><th>Account</th><th>Company</th><th className="n">Amount</th></tr>
        </thead>
        <tbody>
          {state.lines.map((l) => {
            const a = state.accounts[l.account_id];
            const c = companyById.get(l.allocation_location_id);
            return (
              <tr key={l.id}>
                <td className="tnum">{l.line_no}</td>
                <td>{a ? `${a.account_number} · ${a.name}` : '—'}{l.memo ? ` — ${l.memo}` : ''}</td>
                <td>{c?.short_code ?? c?.name ?? '—'}</td>
                <td className="n">{formatMoney(l.amount_cents)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="t-cap">Posted lines are locked. Use Reverse &amp; edit to change them — the posting is voided and the split comes back as a draft.</p>
    </section>
  );
}

/** "Split · 3 lines" tag for the feed tables. */
export function SplitTag({ split }: { split: { lines: number; companies: number; status: 'DRAFT' | 'POSTED' } | null | undefined }) {
  if (!split) return null;
  return (
    <Tag tone={split.status === 'POSTED' ? 'pos' : 'ai'} title={split.status === 'DRAFT' ? 'Saved split, not posted yet' : 'Posted as a split'}>
      Split · {split.lines} lines{split.companies > 1 ? ` · ${split.companies} cos` : ''}
    </Tag>
  );
}
