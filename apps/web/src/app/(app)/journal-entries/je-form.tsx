'use client';

import { useState, useEffect, useMemo, useCallback, type KeyboardEvent } from 'react';
import { Button, Check, Field, InlineNotice, Input, Keyhints, Select, Status, cx } from '@meritbooks/merit-ui';
import { useQuery, useMutation } from '@/hooks';
import { formatMoney, dollarsToCents } from '@meritbooks/shared';
import { useActiveCompany } from '@/lib/hooks/use-active-company';
import { isSpecificCompany } from '@/lib/company-scope';
import { AccountPicker } from './je-account-picker';
import s from './je.module.css';

// ─── Types ──────────────────────────────────────────────────

interface LocationOption {
  id: string;
  name: string;
  short_code: string;
}

interface DeptOption {
  id: string;
  name: string;
  code: string;
  /** /api/departments answers camelCase (locationId, isActive). */
  locationId?: string | null;
  isActive?: boolean;
}

interface ClassOption {
  id: string;
  name: string;
  code: string;
}

interface JELine {
  key: string; // client-side key for React
  account_id: string;
  accountLabel: string;
  debit: string; // string for controlled input
  credit: string;
  memo: string;
  department_id: string;
  class_id: string;
}

interface CreateResult {
  success: boolean;
  entry: { id: string; entryNumber: string; status: string; totalDebitCents: number; lineCount: number };
}

function genKey() { return Math.random().toString(36).slice(2, 8); }

function emptyLine(): JELine {
  return { key: genKey(), account_id: '', accountLabel: '', debit: '', credit: '', memo: '', department_id: '', class_id: '' };
}

// ─── Dollar Input ───────────────────────────────────────────

function DollarInput({ value, onChange, disabled, placeholder, ariaLabel }: {
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  placeholder?: string;
  ariaLabel?: string;
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
        onChange={(e) => {
          const v = e.target.value.replace(/[^0-9.]/g, '');
          // Only allow one decimal point and max 2 decimal places
          const parts = v.split('.');
          if (parts.length > 2) return;
          if (parts[1] && parts[1].length > 2) return;
          onChange(v);
        }}
        disabled={disabled}
        placeholder={placeholder ?? '0.00'}
        className="input input--money"
      />
    </span>
  );
}

// ─── Main Form ──────────────────────────────────────────────

export function JournalEntryForm({ onClose, onSuccess }: {
  onClose: () => void;
  onSuccess: () => void;
}) {
  const { activeCompanyId } = useActiveCompany();
  const [locationId, setLocationId] = useState('');
  const [entryDate, setEntryDate] = useState(new Date().toISOString().split('T')[0]);
  const [entryType, setEntryType] = useState('STANDARD');
  const [memo, setMemo] = useState('');
  const [postImmediately, setPostImmediately] = useState(true);
  const [lines, setLines] = useState<JELine[]>([emptyLine(), emptyLine()]);
  const [formError, setFormError] = useState('');
  const [successMsg, setSuccessMsg] = useState('');

  const { data: locData, isLoading: locLoading, error: locError } = useQuery<LocationOption[]>('/api/locations');
  const locations = useMemo(() => locData ?? [], [locData]);

  // Start on the company the header is scoped to (the page is behind the
  // company-scope guard, so one is active); the select still lets you change it.
  useEffect(() => {
    if (locationId || !isSpecificCompany(activeCompanyId)) return;
    if (locations.some((l) => l.id === activeCompanyId)) setLocationId(activeCompanyId);
  }, [activeCompanyId, locations, locationId]);

  // Dimensions for the line grid (department / class). Consolidated lists; the
  // department list narrows to the chosen company (shared departments always show).
  const { data: deptData } = useQuery<{ departments: DeptOption[] }>('/api/departments', undefined, { scope: false });
  const { data: classData } = useQuery<ClassOption[]>('/api/classes', undefined, { scope: false });
  const departments = useMemo(
    () => (deptData?.departments ?? []).filter((d) => d.isActive !== false && (!d.locationId || !locationId || d.locationId === locationId)),
    [deptData, locationId],
  );
  const classes = Array.isArray(classData) ? classData : [];

  const { mutate, isLoading: submitting, error: mutationError } = useMutation<Record<string, unknown>, CreateResult>(
    '/api/journal-entries'
  );

  // Totals
  const totalDebits = useMemo(() =>
    lines.reduce((sum, l) => sum + (parseFloat(l.debit) || 0), 0),
    [lines]
  );
  const totalCredits = useMemo(() =>
    lines.reduce((sum, l) => sum + (parseFloat(l.credit) || 0), 0),
    [lines]
  );
  const isBalanced = Math.abs(totalDebits - totalCredits) < 0.005 && totalDebits > 0;
  const difference = totalDebits - totalCredits;

  // Line mutations
  const updateLine = useCallback((key: string, field: keyof JELine, value: string) => {
    setLines((prev) => prev.map((l) => {
      if (l.key !== key) return l;
      const updated = { ...l, [field]: value };
      // Auto-clear the other side when entering a debit or credit
      if (field === 'debit' && value) updated.credit = '';
      if (field === 'credit' && value) updated.debit = '';
      return updated;
    }));
  }, []);

  const addLine = useCallback(() => {
    setLines((prev) => [...prev, emptyLine()]);
  }, []);

  const removeLine = useCallback((key: string) => {
    setLines((prev) => prev.length <= 2 ? prev : prev.filter((l) => l.key !== key));
  }, []);

  // Submit
  const handleSubmit = useCallback(async () => {
    setFormError('');
    setSuccessMsg('');

    if (!locationId) { setFormError('Select a company'); return; }
    if (!entryDate) { setFormError('Enter a date'); return; }

    const validLines = lines.filter((l) => l.account_id && (parseFloat(l.debit) > 0 || parseFloat(l.credit) > 0));
    if (validLines.length < 2) { setFormError('At least 2 lines with amounts required'); return; }
    if (!isBalanced) { setFormError(`Entry is not balanced. Difference: ${formatMoney(dollarsToCents(difference))}`); return; }

    const payload = {
      location_id: locationId,
      entry_date: entryDate,
      entry_type: entryType,
      memo: memo || undefined,
      post_immediately: postImmediately,
      lines: validLines.map((l) => ({
        account_id: l.account_id,
        debit_cents: dollarsToCents(parseFloat(l.debit) || 0),
        credit_cents: dollarsToCents(parseFloat(l.credit) || 0),
        location_id: locationId,
        department_id: l.department_id || null,
        class_id: l.class_id || null,
        memo: l.memo || null,
      })),
    };

    const result = await mutate(payload);

    if (result?.success) {
      setSuccessMsg(`${result.entry.entryNumber} ${postImmediately ? 'posted' : 'saved as draft'} — ${formatMoney(result.entry.totalDebitCents)}`);
      setTimeout(() => {
        onSuccess();
      }, 1200);
    } else {
      setFormError("The entry wasn't saved.");
    }
  }, [locationId, entryDate, entryType, memo, postImmediately, lines, isBalanced, difference, mutate, onSuccess]);

  const canSubmit = !submitting && isBalanced && !!locationId;

  // ⌘/Ctrl + Enter posts (or saves) from anywhere in the form.
  const onFormKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (canSubmit) void handleSubmit();
    }
  };

  const hasAmounts = totalDebits > 0 || totalCredits > 0;

  return (
    <section className={s.form} aria-label="New journal entry" onKeyDown={onFormKeyDown}>
      {/* Header */}
      <div className={s.formHead}>
        <div className={s.formHeadMain}>
          <h2 className="t-section">New journal entry</h2>
          <span className="t-cap">Debits must equal credits before it can post.</span>
        </div>
        <Button variant="quiet" iconOnly icon="x" onClick={onClose} aria-label="Close new journal entry form" />
      </div>

      <div className={s.formBody}>
        {/* Top controls */}
        <div className={s.grid4}>
          <Field
            label="Company"
            error={locError ? "Companies didn't load. Close the form and try again." : undefined}
          >
            <Select value={locationId} onChange={(e) => setLocationId(e.target.value)} disabled={locLoading && locations.length === 0}>
              <option value="">{locLoading && locations.length === 0 ? 'Loading companies…' : 'Select company…'}</option>
              {locations.map((loc) => (
                <option key={loc.id} value={loc.id}>{loc.short_code} · {loc.name}</option>
              ))}
            </Select>
          </Field>
          <Field label="Date" help="A closed period refuses the post.">
            <Input
              type="date"
              className="tnum"
              value={entryDate}
              onChange={(e) => setEntryDate(e.target.value)}
            />
          </Field>
          <Field label="Type">
            <Select value={entryType} onChange={(e) => setEntryType(e.target.value)}>
              <option value="STANDARD">Standard</option>
              <option value="ADJUSTING">Adjusting</option>
              <option value="CLOSING">Closing</option>
              <option value="REVERSING">Reversing</option>
            </Select>
          </Field>
          <Field label="Memo">
            <Input
              type="text"
              value={memo}
              onChange={(e) => setMemo(e.target.value)}
              placeholder="What this entry records"
            />
          </Field>
        </div>

        {/* Line items */}
        <div className={s.lines}>
          <table className="tbl" aria-label="Journal entry lines">
            <colgroup>
              <col style={{ width: 48 }} />
              <col />
              <col style={{ width: 150 }} />
              <col style={{ width: 132 }} />
              <col style={{ width: 128 }} />
              <col style={{ width: 128 }} />
              <col style={{ width: 160 }} />
              <col style={{ width: 56 }} />
            </colgroup>
            <thead>
              <tr>
                <th scope="col">#</th>
                <th scope="col">Account</th>
                <th scope="col">Department</th>
                <th scope="col">Class</th>
                <th scope="col" className="n">Debit</th>
                <th scope="col" className="n">Credit</th>
                <th scope="col">Line memo</th>
                <th scope="col"><span className="sr">Remove</span></th>
              </tr>
            </thead>
            <tbody>
              {lines.map((line, idx) => (
                <tr key={line.key}>
                  <td><span className={cx('tnum', s.lineNo)}>{idx + 1}</span></td>
                  <td>
                    <AccountPicker
                      value={line.account_id}
                      label={line.accountLabel}
                      ariaLabel={`Line ${idx + 1} account`}
                      onChange={(id, label) => {
                        setLines((prev) => prev.map((l) =>
                          l.key === line.key ? { ...l, account_id: id, accountLabel: label } : l
                        ));
                      }}
                      locationId={locationId}
                    />
                  </td>
                  <td>
                    <Select
                      aria-label={`Line ${idx + 1} department`}
                      value={line.department_id}
                      onChange={(e) => updateLine(line.key, 'department_id', e.target.value)}
                    >
                      <option value="">None</option>
                      {departments.map((d) => <option key={d.id} value={d.id}>{d.code ? `${d.code} · ` : ''}{d.name}</option>)}
                    </Select>
                  </td>
                  <td>
                    <Select
                      aria-label={`Line ${idx + 1} class`}
                      value={line.class_id}
                      onChange={(e) => updateLine(line.key, 'class_id', e.target.value)}
                    >
                      <option value="">None</option>
                      {classes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
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
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={4}>
                  <Button variant="quiet" icon="plus" onClick={addLine}>Add line</Button>
                </td>
                <td className="n">{formatMoney(dollarsToCents(totalDebits))}</td>
                <td className="n">{formatMoney(dollarsToCents(totalCredits))}</td>
                <td colSpan={2}>
                  {hasAmounts ? (
                    isBalanced ? (
                      <Status kind="ready">Balanced</Status>
                    ) : (
                      <Status kind="blocked">Off by {formatMoney(dollarsToCents(Math.abs(difference)))}</Status>
                    )
                  ) : (
                    <span className="t-cap">Enter amounts</span>
                  )}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>

        {/* Error / Success */}
        {formError && (
          <InlineNotice tone="neg" title={formError}>
            {mutationError ? mutationError : 'Fix the issue above, then post again.'}
          </InlineNotice>
        )}
        {successMsg && (
          <InlineNotice title="Saved.">{successMsg}</InlineNotice>
        )}

        {/* Actions */}
        <div className={s.formFoot}>
          <Check
            label="Post immediately"
            checked={postImmediately}
            onChange={(e) => setPostImmediately(e.target.checked)}
          />
          <Keyhints hints={[{ chord: 'mod+enter', label: postImmediately ? 'Post' : 'Save' }]} />
          <div className={s.formActs}>
            <Button variant="quiet" onClick={onClose}>Cancel</Button>
            <Button
              variant="primary"
              icon={postImmediately ? 'check' : undefined}
              onClick={handleSubmit}
              disabled={!canSubmit}
              aria-busy={submitting || undefined}
            >
              {submitting ? (postImmediately ? 'Posting…' : 'Saving…') : postImmediately ? 'Post entry' : 'Save draft'}
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}
