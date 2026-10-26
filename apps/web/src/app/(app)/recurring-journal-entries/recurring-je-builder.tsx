'use client';

import { useState, useEffect, useMemo, useCallback, type KeyboardEvent } from 'react';
import {
  Button, Check, Dialog, Field, InlineNotice, Input, Keyhints, Select, Status, cx, parseMoneyToCents,
} from '@meritbooks/merit-ui';
import { useQuery } from '@/hooks';
import { api } from '@/lib/api-client';
import { addToast } from '@/hooks/use-toast';
import { formatMoney } from '@meritbooks/shared';
import { useActiveCompany } from '@/lib/hooks/use-active-company';
import { isSpecificCompany } from '@/lib/company-scope';
import { AccountPicker, type AccountOption } from '../journal-entries/je-account-picker';
import s from './recurring-builder.module.css';

// ─── Types ──────────────────────────────────────────────────

interface LocationOption { id: string; name: string; short_code: string; }
interface DeptOption { id: string; name: string; code: string; locationId: string | null; }

/** /api/accounts/search answers `{ recent, accounts }` (older shape: `data`). */
interface AccountSearchResponse {
  recent?: AccountOption[];
  accounts?: AccountOption[];
  data?: AccountOption[];
}

export interface ExistingTemplate {
  id: string;
  name: string;
  location_id: string;
  cadence: 'MONTHLY' | 'QUARTERLY';
  start_date: string;
  end_date: string | null;
  entry_type: string;
  memo: string | null;
  lines: {
    account_id: string;
    debit_cents: number;
    credit_cents: number;
    department_id?: string | null;
    memo?: string | null;
  }[];
}

interface BuilderLine {
  key: string;
  account_id: string;
  accountLabel: string;
  debit: string;
  credit: string;
  department_id: string;
  memo: string;
}

function genKey() { return Math.random().toString(36).slice(2, 8); }
function emptyLine(): BuilderLine {
  return { key: genKey(), account_id: '', accountLabel: '', debit: '', credit: '', department_id: '', memo: '' };
}

/** Typed dollars → integer cents, parsed without floating point. Blank / partial input is 0. */
function toCents(v: string): number {
  return parseMoneyToCents(v) ?? 0;
}

/** Integer cents → the plain "1234.50" text the amount inputs edit. */
function centsToInput(cents: number): string {
  if (cents <= 0) return '';
  return `${Math.trunc(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}

function DollarInput({ value, onChange, disabled, ariaLabel }: {
  value: string; onChange: (v: string) => void; disabled?: boolean; ariaLabel?: string;
}) {
  return (
    <span className={s.money}>
      <span aria-hidden="true">$</span>
      <input
        type="text"
        inputMode="decimal"
        autoComplete="off"
        aria-label={ariaLabel}
        value={value}
        disabled={disabled}
        onChange={(e) => {
          const v = e.target.value.replace(/[^0-9.]/g, '');
          const parts = v.split('.');
          if (parts.length > 2) return;
          if (parts[1] && parts[1].length > 2) return;
          onChange(v);
        }}
        placeholder="0.00"
        className="input input--money"
      />
    </span>
  );
}

// ─── Allocation helper ──────────────────────────────────────

function AllocationHelper({ locationId, departments, onGenerate, onCancel }: {
  locationId: string;
  departments: DeptOption[];
  onGenerate: (lines: BuilderLine[]) => void;
  onCancel: () => void;
}) {
  const [total, setTotal] = useState('');
  const [offset, setOffset] = useState({ id: '', label: '' });
  const [expenseAcct, setExpenseAcct] = useState({ id: '', label: '' });
  const [picked, setPicked] = useState<string[]>([]);

  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  const build = () => {
    const cents = toCents(total);
    if (cents <= 0) { addToast('error', 'Enter an accrual amount'); return; }
    if (!expenseAcct.id) { addToast('error', 'Pick the expense/cost account to allocate'); return; }
    if (!offset.id) { addToast('error', 'Pick the offset (e.g. accrued liability) account'); return; }
    if (picked.length < 1) { addToast('error', 'Pick at least one department'); return; }
    // Even split with remainder on the last bucket (mirrors the pure engine).
    const per = Math.floor(cents / picked.length);
    let remaining = cents;
    const lines: BuilderLine[] = picked.map((deptId, i) => {
      const amt = i === picked.length - 1 ? remaining : per;
      remaining -= amt;
      return {
        key: genKey(),
        account_id: expenseAcct.id,
        accountLabel: expenseAcct.label,
        debit: centsToInput(amt),
        credit: '',
        department_id: deptId,
        memo: '',
      };
    });
    lines.push({ key: genKey(), account_id: offset.id, accountLabel: offset.label, debit: '', credit: centsToInput(cents), department_id: '', memo: '' });
    onGenerate(lines);
    addToast('success', `Built ${lines.length} balanced lines`);
  };

  const totalCents = toCents(total);
  const share = picked.length > 0 && totalCents > 0 ? Math.floor(totalCents / picked.length) : 0;

  return (
    <section className={s.alloc} aria-label="Allocate across departments">
      <div className={s.allocHead}>
        <h3>Allocate a fixed accrual straight-line across departments</h3>
        <span className="t-cap">Replaces the lines below.</span>
      </div>
      <div className={s.grid3}>
        <Field label="Accrual amount">
          <DollarInput value={total} onChange={setTotal} ariaLabel="Accrual amount" />
        </Field>
        <Field label="Expense / cost account (debit)">
          <AccountPicker
            value={expenseAcct.id}
            label={expenseAcct.label}
            locationId={locationId}
            ariaLabel="Expense or cost account"
            onChange={(id, label) => setExpenseAcct({ id, label })}
          />
        </Field>
        <Field label="Offset account (credit)">
          <AccountPicker
            value={offset.id}
            label={offset.label}
            locationId={locationId}
            ariaLabel="Offset account"
            onChange={(id, label) => setOffset({ id, label })}
          />
        </Field>
      </div>
      <fieldset className={s.fieldset}>
        <legend className={cx('t-cap', s.deptLabel)}>Departments to split across</legend>
        {departments.length === 0 ? (
          <p className="t-cap">
            {locationId ? 'This company has no departments yet.' : 'Choose a company first to see its departments.'}
          </p>
        ) : (
          <div className={s.depts}>
            {departments.map((d) => (
              <Check key={d.id} label={d.name} checked={picked.includes(d.id)} onChange={() => toggle(d.id)} />
            ))}
          </div>
        )}
      </fieldset>
      <div className={s.allocFoot}>
        <span className="t-cap tnum">
          {share > 0
            ? `${picked.length} department${picked.length === 1 ? '' : 's'} · about ${formatMoney(share)} each`
            : 'Any remainder cent lands on the last department.'}
        </span>
        <span className="mb-row-acts">
          <Button variant="quiet" onClick={onCancel}>Close</Button>
          <Button icon="layers" onClick={build}>Build allocated lines</Button>
        </span>
      </div>
    </section>
  );
}

// ─── Builder dialog ─────────────────────────────────────────

export function RecurringJeBuilder({ existing, onClose, onSaved }: {
  existing: ExistingTemplate | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const editing = !!existing;
  const { activeCompanyId } = useActiveCompany();
  const [name, setName] = useState(existing?.name ?? '');
  const [locationId, setLocationId] = useState(existing?.location_id ?? '');
  const [cadence, setCadence] = useState<'MONTHLY' | 'QUARTERLY'>(existing?.cadence ?? 'MONTHLY');
  const [startDate, setStartDate] = useState(existing?.start_date ?? new Date().toISOString().slice(0, 10));
  const [endDate, setEndDate] = useState(existing?.end_date ?? '');
  const [entryType, setEntryType] = useState(existing?.entry_type ?? 'ADJUSTING');
  const [memo, setMemo] = useState(existing?.memo ?? '');
  const [showAlloc, setShowAlloc] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');
  const [attempted, setAttempted] = useState(false);

  const [lines, setLines] = useState<BuilderLine[]>(
    existing
      ? existing.lines.map((l) => ({
          key: genKey(),
          account_id: l.account_id,
          accountLabel: '', // number/name aren't stored on the line — resolved below
          debit: centsToInput(l.debit_cents),
          credit: centsToInput(l.credit_cents),
          department_id: l.department_id ?? '',
          memo: l.memo ?? '',
        }))
      : [emptyLine(), emptyLine()],
  );

  const { data: locData, isLoading: locLoading, error: locError } = useQuery<LocationOption[]>('/api/locations');
  const locations = useMemo(() => locData ?? [], [locData]);
  const { data: deptData } = useQuery<{ departments: DeptOption[] }>('/api/departments');
  const departments = useMemo(
    () => (deptData?.departments ?? []).filter((d) => !locationId || !d.locationId || d.locationId === locationId),
    [deptData, locationId],
  );

  // A new template starts on the company the header is scoped to; the select still changes it.
  useEffect(() => {
    if (editing || locationId || !isSpecificCompany(activeCompanyId)) return;
    if (locations.some((l) => l.id === activeCompanyId)) setLocationId(activeCompanyId);
  }, [editing, activeCompanyId, locations, locationId]);

  // Editing: the saved lines carry only account ids, so look up "number · name" once.
  const needsLabels = editing && lines.some((l) => l.account_id && !l.accountLabel);
  const { data: acctData, isLoading: acctLoading } = useQuery<AccountSearchResponse>(
    needsLabels ? '/api/accounts/search' : null,
    undefined,
    { scope: false },
  );
  const accountLabels = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of [...(acctData?.recent ?? []), ...(acctData?.accounts ?? []), ...(acctData?.data ?? [])]) {
      m.set(a.id, `${a.account_number} · ${a.name}`);
    }
    return m;
  }, [acctData]);
  const labelFor = (line: BuilderLine): string => {
    if (line.accountLabel || !line.account_id) return line.accountLabel;
    return accountLabels.get(line.account_id) ?? (acctLoading ? 'Loading account…' : 'Account on file');
  };

  // Integer cents throughout — debits must equal credits exactly.
  const totalDebits = useMemo(() => lines.reduce((sum, l) => sum + toCents(l.debit), 0), [lines]);
  const totalCredits = useMemo(() => lines.reduce((sum, l) => sum + toCents(l.credit), 0), [lines]);
  const difference = totalDebits - totalCredits;
  const isBalanced = difference === 0 && totalDebits > 0;
  const hasAmounts = totalDebits > 0 || totalCredits > 0;

  const updateLine = useCallback((key: string, field: keyof BuilderLine, value: string) => {
    setLines((prev) => prev.map((l) => {
      if (l.key !== key) return l;
      const u = { ...l, [field]: value };
      if (field === 'debit' && value) u.credit = '';
      if (field === 'credit' && value) u.debit = '';
      return u;
    }));
  }, []);
  const addLine = useCallback(() => setLines((p) => [...p, emptyLine()]), []);
  const removeLine = useCallback((key: string) => setLines((p) => (p.length <= 2 ? p : p.filter((l) => l.key !== key))), []);

  const canSave = !saving && isBalanced && !!locationId && !!name.trim();

  async function save() {
    setFormError('');
    setAttempted(true);
    if (!name.trim()) { setFormError('Name the template'); return; }
    if (!locationId) { setFormError('Select a company'); return; }
    const valid = lines.filter((l) => l.account_id && (toCents(l.debit) > 0 || toCents(l.credit) > 0));
    if (valid.length < 2) { setFormError('At least 2 lines with amounts required'); return; }
    if (!isBalanced) { setFormError(`Not balanced — off by ${formatMoney(Math.abs(difference))}`); return; }
    if (endDate && endDate < startDate) { setFormError('End date must be on or after the start date'); return; }

    const payload = {
      location_id: locationId,
      name: name.trim(),
      cadence,
      start_date: startDate,
      end_date: endDate || null,
      entry_type: entryType,
      memo: memo || null,
      lines: valid.map((l) => ({
        account_id: l.account_id,
        debit_cents: toCents(l.debit),
        credit_cents: toCents(l.credit),
        department_id: l.department_id || null,
        memo: l.memo || null,
      })),
    };

    setSaving(true);
    const res = editing
      ? await api.patch(`/api/recurring-journal-entries/${existing!.id}`, payload)
      : await api.post('/api/recurring-journal-entries', payload);
    setSaving(false);
    if (res.error) { setFormError(res.error.error || 'Failed to save'); return; }
    addToast('success', editing ? 'Template updated' : 'Recurring template created');
    onSaved();
  }

  const close = () => { if (!saving) onClose(); };

  // ⌘/Ctrl + Enter saves from anywhere in the form.
  const onBodyKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // The account picker claims plain Enter (and prevents default) to pick a row.
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.defaultPrevented) {
      e.preventDefault();
      if (canSave) void save();
    }
  };

  const verb = editing ? 'Save changes' : 'Create template';

  return (
    <Dialog
      open
      onClose={close}
      title={editing ? `Edit “${existing!.name}”` : 'New recurring journal entry'}
      width={1040}
      className={s.dialog}
      dismissOnScrim={false}
      footNote={
        <span className={s.foot}>
          <Keyhints hints={[{ chord: 'mod+enter', label: editing ? 'Save' : 'Create' }]} />
          <span>Each period waits for your approval before it posts.</span>
        </span>
      }
      actions={
        <>
          <Button onClick={close} disabled={saving}>Cancel</Button>
          <Button
            variant="primary"
            icon="check"
            onClick={() => void save()}
            disabled={!canSave}
            aria-busy={saving || undefined}
          >
            {saving ? 'Saving…' : verb}
          </Button>
        </>
      }
    >
      <div className={s.body} onKeyDown={onBodyKeyDown}>
        <div className={s.grid4}>
          <Field label="Template name" className={s.span2} error={attempted && !name.trim() ? 'Name the template.' : undefined}>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Monthly rent accrual"
              invalid={attempted && !name.trim()}
              data-autofocus
            />
          </Field>
          <Field
            label="Company"
            error={
              locError
                ? "Companies didn't load. Close and try again."
                : attempted && !locationId ? 'Choose a company.' : undefined
            }
          >
            <Select
              value={locationId}
              onChange={(e) => setLocationId(e.target.value)}
              disabled={locLoading && locations.length === 0}
              invalid={attempted && !locationId}
            >
              <option value="">{locLoading && locations.length === 0 ? 'Loading companies…' : 'Select company…'}</option>
              {locations.map((loc) => <option key={loc.id} value={loc.id}>{loc.short_code} · {loc.name}</option>)}
            </Select>
          </Field>
          <Field label="Cadence">
            <Select value={cadence} onChange={(e) => setCadence(e.target.value as 'MONTHLY' | 'QUARTERLY')}>
              <option value="MONTHLY">Monthly</option>
              <option value="QUARTERLY">Quarterly</option>
            </Select>
          </Field>
          <Field label="Type">
            <Select value={entryType} onChange={(e) => setEntryType(e.target.value)}>
              <option value="ADJUSTING">Adjusting</option>
              <option value="STANDARD">Standard</option>
              <option value="CLOSING">Closing</option>
              <option value="REVERSING">Reversing</option>
            </Select>
          </Field>
          <Field label="Starts" help="The first period it proposes.">
            <Input type="date" className="tnum" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
          </Field>
          <Field
            label={<>Ends <span className={s.optional}>(optional)</span></>}
            error={endDate && endDate < startDate ? 'Must be on or after the start date.' : undefined}
            help={endDate ? undefined : 'Leave blank to run until cancelled.'}
          >
            <Input
              type="date"
              className="tnum"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              invalid={!!endDate && endDate < startDate}
            />
          </Field>
          <Field label={<>Memo <span className={s.optional}>(optional)</span></>} className={s.span2}>
            <Input value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="Posted each period with the period appended" />
          </Field>
        </div>

        <div className={s.explain}>
          <p className="t-cap">
            The same balanced entry posts every period. Each period is proposed for your approval before it reaches the GL.
          </p>
          <Button
            variant="quiet"
            icon="layers"
            onClick={() => setShowAlloc((v) => !v)}
            aria-expanded={showAlloc}
          >
            {showAlloc ? 'Hide allocation' : 'Allocate across departments'}
          </Button>
        </div>

        {showAlloc && (
          <AllocationHelper
            locationId={locationId}
            departments={departments}
            onGenerate={(l) => { setLines(l); setShowAlloc(false); }}
            onCancel={() => setShowAlloc(false)}
          />
        )}

        <div className={s.lines}>
          <table className="tbl" aria-label="Recurring entry lines">
            <colgroup>
              <col style={{ width: 48 }} />
              <col />
              <col style={{ width: 168 }} />
              <col style={{ width: 128 }} />
              <col style={{ width: 128 }} />
              <col style={{ width: 168 }} />
              <col style={{ width: 56 }} />
            </colgroup>
            <thead>
              <tr>
                <th scope="col">#</th>
                <th scope="col">Account</th>
                <th scope="col">Department</th>
                <th scope="col" className="n">Debit</th>
                <th scope="col" className="n">Credit</th>
                <th scope="col">Line memo</th>
                <th scope="col"><span className="sr">Remove</span></th>
              </tr>
            </thead>
            <tbody>
              {lines.map((line, idx) => {
                const lineHasAmount = toCents(line.debit) > 0 || toCents(line.credit) > 0;
                return (
                  <tr key={line.key}>
                    <td><span className={cx('tnum', s.lineNo)}>{idx + 1}</span></td>
                    <td>
                      <AccountPicker
                        value={line.account_id}
                        label={labelFor(line)}
                        locationId={locationId}
                        ariaLabel={`Line ${idx + 1} account`}
                        invalid={attempted && lineHasAmount && !line.account_id}
                        onChange={(id, label) => setLines((prev) => prev.map((l) => (l.key === line.key ? { ...l, account_id: id, accountLabel: label } : l)))}
                      />
                    </td>
                    <td>
                      <Select
                        aria-label={`Line ${idx + 1} department`}
                        value={line.department_id}
                        onChange={(e) => updateLine(line.key, 'department_id', e.target.value)}
                      >
                        <option value="">None</option>
                        {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                      </Select>
                    </td>
                    <td>
                      <DollarInput
                        value={line.debit}
                        onChange={(v) => updateLine(line.key, 'debit', v)}
                        disabled={!!line.credit}
                        ariaLabel={`Line ${idx + 1} debit amount`}
                      />
                    </td>
                    <td>
                      <DollarInput
                        value={line.credit}
                        onChange={(v) => updateLine(line.key, 'credit', v)}
                        disabled={!!line.debit}
                        ariaLabel={`Line ${idx + 1} credit amount`}
                      />
                    </td>
                    <td>
                      <Input
                        type="text"
                        value={line.memo}
                        onChange={(e) => updateLine(line.key, 'memo', e.target.value)}
                        placeholder="—"
                        aria-label={`Line ${idx + 1} memo`}
                      />
                    </td>
                    <td className="n">
                      <Button
                        variant="quiet"
                        iconOnly
                        icon="x"
                        onClick={() => removeLine(line.key)}
                        disabled={lines.length <= 2}
                        aria-label={`Remove line ${idx + 1}`}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={3}>
                  <Button variant="quiet" icon="plus" onClick={addLine}>Add line</Button>
                </td>
                <td className="n">{formatMoney(totalDebits)}</td>
                <td className="n">{formatMoney(totalCredits)}</td>
                <td colSpan={2}>
                  {hasAmounts ? (
                    isBalanced ? (
                      <Status kind="ready">Balanced</Status>
                    ) : (
                      <Status kind="blocked">Off by {formatMoney(Math.abs(difference))}</Status>
                    )
                  ) : (
                    <span className="t-cap">Enter amounts</span>
                  )}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>

        {formError && (
          <InlineNotice tone="neg" title={editing ? 'Not saved.' : 'Not created.'}>
            {formError}
          </InlineNotice>
        )}
      </div>
    </Dialog>
  );
}
