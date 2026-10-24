'use client';

/**
 * Plan tab (Wave 4B): company + year + version, a department, and its grid — edit / paste / fill /
 * ±%, drivers, start from last year or a template, upload a file, comment on a line, save.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Dialog, Field, Input, InlineNotice, Select, Tag, api, money, toast, useQuery } from '@meritbooks/merit-ui';
import { fillRight, growRow, parsePercentToBps } from '@/lib/budgets/grid';
import { PLAN_STATUS_LABEL, type GridResponse, type GridRow } from '@/lib/budgets/types';
import { BudgetGrid, dirtyKey, effectiveValues, type RowAction } from './budget-grid';
import { BudgetImport } from './budget-import';
import { CommentsDrawer } from './comments-drawer';
import { DriverDrawer } from './driver-drawer';
import { StartPanel } from './start-panel';
import { ScopeBar, useBudgetScope } from './budget-scope';
import { VersionBar } from './version-bar';
import { MONTH_LABELS, errText, isIncomeType } from './budget-format';
import s from './budgets.module.css';

const COMPANY = 'company';

export function PlanWorkspace() {
  const sc = useBudgetScope();
  const a = sc.access;
  const [dept, setDept] = useState<string>('');
  // Department scope: a department head never gets the company-level lines.
  useEffect(() => {
    if (!a) return;
    if (a.scope === 'DEPARTMENTS') {
      if (!dept || dept === COMPANY || !sc.departments.some((d) => d.id === dept)) setDept(sc.departments[0]?.id ?? '');
    } else if (!dept) setDept(COMPANY);
  }, [a, dept, sc.departments]);

  const departmentId = dept === COMPANY ? null : dept || null;
  const deptName = departmentId ? sc.departments.find((d) => d.id === departmentId)?.name ?? 'Department' : 'Company level';
  const gridQ = useQuery<GridResponse>(sc.versionId && dept ? '/api/budgets/lines' : null, { version_id: sc.versionId ?? undefined, department_id: dept });
  const grid = gridQ.data;

  const [dirty, setDirty] = useState<Map<string, number>>(new Map());
  const [added, setAdded] = useState<GridRow[]>([]);
  const [announce, setAnnounce] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => { setDirty(new Map()); setAdded([]); }, [sc.versionId, dept]);

  const rows = useMemo(() => {
    const base = grid?.rows ?? [];
    const have = new Set(base.map((r) => r.key));
    return [...base, ...added.filter((r) => !have.has(r.key))];
  }, [grid, added]);
  const editable = !!grid?.editable;

  const closedPeriods = useMemo(() => grid?.closedPeriods ?? [], [grid]);
  const onEdit = useCallback((edits: Array<{ rowKey: string; period: number; cents: number }>) => {
    setDirty((d) => {
      const n = new Map(d);
      for (const e of edits) {
        if (closedPeriods.includes(e.period)) continue; // a closed month's budget can't change
        const row = rows.find((r) => r.key === e.rowKey);
        const orig = row ? (e.period === 13 ? row.adjustmentsCents : row.months[e.period - 1]) : 0;
        if (orig === e.cents) n.delete(dirtyKey(e.rowKey, e.period));
        else n.set(dirtyKey(e.rowKey, e.period), e.cents);
      }
      return n;
    });
  }, [rows, closedPeriods]);

  const [driverRow, setDriverRow] = useState<GridRow | null>(null);
  const [commentRow, setCommentRow] = useState<GridRow | null>(null);
  const [growRowKey, setGrowRowKey] = useState<string | null>(null);
  const [growText, setGrowText] = useState('5');
  const [starting, setStarting] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [addAccount, setAddAccount] = useState('');

  const onRowAction = (rowKey: string, action: RowAction, fromPeriod: number) => {
    const row = rows.find((r) => r.key === rowKey);
    if (!row) return;
    const vals = effectiveValues(row, dirty).slice(0, 12);
    if (action === 'fill') {
      const next = fillRight(vals, fromPeriod - 1);
      onEdit(next.map((cents, i) => ({ rowKey, period: i + 1, cents })));
      setAnnounce(`Filled ${row.accountName} from ${fromPeriod === 1 ? 'January' : `month ${fromPeriod}`} to December.`);
    } else if (action === 'grow') {
      setGrowRowKey(rowKey);
    } else if (action === 'driver') {
      setDriverRow(row);
    } else {
      setCommentRow(row);
    }
  };

  const applyGrow = () => {
    const bps = parsePercentToBps(growText);
    const row = rows.find((r) => r.key === growRowKey);
    if (bps === null || !row) return;
    const next = growRow(effectiveValues(row, dirty).slice(0, 12), bps);
    onEdit(next.map((cents, i) => ({ rowKey: row.key, period: i + 1, cents })));
    setAnnounce(`${row.accountName} changed by ${growText}%.`);
    setGrowRowKey(null);
  };

  const save = async () => {
    if (!sc.versionId || dirty.size === 0) return;
    setSaving(true);
    const edits = [...dirty.entries()].map(([k, cents]) => {
      const [rowKey, p] = k.split('#');
      return { account_id: rowKey.split('|')[0], period_number: Number(p), amount_cents: cents };
    });
    const res = await api.put<{ changed: number }>('/api/budgets/lines', { version_id: sc.versionId, department_id: departmentId, edits, source: 'MANUAL' });
    setSaving(false);
    if (res.error) {
      toast.error(errText(res.error));
      setAnnounce(`Not saved: ${errText(res.error)}`);
      return;
    }
    toast(`Saved ${res.data?.changed ?? edits.length} cells`);
    setAnnounce(`Saved ${res.data?.changed ?? edits.length} cells.`);
    setDirty(new Map());
    setAdded([]);
    await gridQ.refetch();
  };

  const [submitting, setSubmitting] = useState(false);
  const submitDept = async () => {
    if (!sc.versionId || !departmentId) return;
    setSubmitting(true);
    const res = await api.post('/api/budgets/plans', { version_id: sc.versionId, department_id: departmentId, action: 'submit' });
    setSubmitting(false);
    if (res.error) {
      toast.error(errText(res.error));
      return;
    }
    toast(`${deptName} submitted for review`);
    setAnnounce(`${deptName} submitted for review.`);
    await gridQ.refetch();
  };

  const reload = async () => {
    setDirty(new Map());
    await gridQ.refetch();
  };

  const addRow = () => {
    const acct = grid?.accounts.find((x) => x.id === addAccount);
    if (!acct) return;
    const key = `${acct.id}|${departmentId ?? ''}`;
    if (!rows.some((r) => r.key === key)) {
      setAdded((x) => [...x, {
        key, accountId: acct.id, accountNumber: acct.number, accountName: acct.name, accountType: acct.type, groupName: acct.groupName,
        departmentId, months: Array(12).fill(0), adjustmentsCents: 0, totalCents: 0, pyActualCents: 0, pyMonths: Array(12).fill(0), driver: null, sources: [], comments: 0,
      }]);
    }
    setAddOpen(false);
    setAddAccount('');
  };

  const unsavedTotal = useMemo(() => {
    let rev = 0;
    let exp = 0;
    for (const r of rows) {
      const t = effectiveValues(r, dirty).reduce((x, y) => x + y, 0);
      if (isIncomeType(r.accountType)) rev += t;
      else exp += t;
    }
    return { rev, exp };
  }, [rows, dirty]);

  return (
    <div>
      <ScopeBar>
        {sc.locationId && a && sc.versions.length > 0 && (
          <Field label="Department" className={s.wide}>
            <Select value={dept} onChange={(e) => { if (dirty.size) { toast.error('Save or discard your changes before switching department.'); return; } setDept(e.target.value); }}>
              {a.scope === 'ALL' && <option value={COMPANY}>Company level (no department)</option>}
              {sc.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </Select>
          </Field>
        )}
      </ScopeBar>
      {!sc.locationId ? (
        <div className={`${s.surface} ${s.state}`}><strong>Choose a company</strong><p>Budgets are built per company and fiscal year.</p></div>
      ) : (
        <>
          <VersionBar />
          {a && !a.canView && <InlineNotice tone="warn" className={s.notice}>You don’t have access to this company’s budgets.</InlineNotice>}
          {!sc.loading && sc.versions.length === 0 && !sc.error && (
            <div className={`${s.surface} ${s.state}`}>
              <strong>No FY {sc.fiscalYear} budget yet</strong>
              <p>{a?.scope === 'ALL' && a.canEdit ? 'Create version 1 with “New version” — start blank, or from last year’s actuals plus a growth %.' : 'Finance hasn’t opened the FY budget yet.'}</p>
            </div>
          )}
          {a?.scope === 'DEPARTMENTS' && sc.departments.length === 0 && (
            <InlineNotice tone="info" className={s.notice}>No departments are assigned to you yet. Ask finance to make you a department owner.</InlineNotice>
          )}
          {sc.versionId && dept && (
            <div className={s.surface}>
              <div className={s.toolbar}>
                <span className={s.toolbarTitle}>{deptName}{grid ? ` · revenue ${money(unsavedTotal.rev)} · expense ${money(unsavedTotal.exp)}` : ''}</span>
                {editable && <Button onClick={() => setStarting(true)}>Start from…</Button>}
                {editable && grid && sc.locationId && (
                  <BudgetImport locationId={sc.locationId} fiscalYear={sc.fiscalYear} departmentId={departmentId} versionId={sc.versionId} onImported={reload} />
                )}
                {editable && <Button icon="plus" onClick={() => setAddOpen(true)}>Add account</Button>}
                <Button variant="quiet" onClick={reload} disabled={gridQ.isLoading}>Reload</Button>
                {editable && departmentId && grid && (grid.planStatus === 'DRAFT' || grid.planStatus === 'RETURNED') && (
                  <Button variant="primary" onClick={submitDept} disabled={submitting || dirty.size > 0} title={dirty.size > 0 ? 'Save your changes first' : undefined}>
                    {submitting ? 'Submitting…' : 'Submit for review'}
                  </Button>
                )}
                {grid?.planStatus && departmentId && <Tag tone={grid.planStatus === 'APPROVED' ? 'pos' : grid.planStatus === 'RETURNED' ? 'warn' : 'default'}>{PLAN_STATUS_LABEL[grid.planStatus]}</Tag>}
              </div>
              {gridQ.isLoading && !grid && <div className={s.state} aria-busy="true">Loading the grid…</div>}
              {gridQ.error && <InlineNotice tone="neg" title="Couldn’t load this budget" className={s.notice}>{gridQ.error}</InlineNotice>}
              {grid && !grid.editable && grid.lockReason && <InlineNotice tone="info" className={s.notice}>{grid.lockReason}</InlineNotice>}
              {grid && grid.editable && closedPeriods.length > 0 && (
                <InlineNotice tone="info" className={s.notice}>
                  {closedPeriods.map((m) => MONTH_LABELS[m - 1]).join(', ')} {sc.fiscalYear} {closedPeriods.length === 1 ? 'is' : 'are'} closed — those months are read-only. Drivers and templates keep their budget as it is.
                </InlineNotice>
              )}
              {grid && rows.length === 0 && (
                <div className={s.state}>
                  <strong>No lines yet</strong>
                  <p>{editable ? 'Start from last year’s actuals or a template, upload a file, or add accounts one by one.' : 'Nothing has been budgeted here.'}</p>
                  {editable && <Button variant="primary" onClick={() => setStarting(true)}>Start this budget</Button>}
                </div>
              )}
              {grid && rows.length > 0 && (
                <BudgetGrid rows={rows} dirty={dirty} editable={editable} onEdit={onEdit} onRowAction={onRowAction} onAnnounce={setAnnounce} closedPeriods={closedPeriods} />
              )}
              <div className={s.saveBar}>
                <span className={s.hint}>
                  {editable ? 'Arrows / Tab move · type or Enter to edit · Esc cancels · ⌘/Ctrl+V pastes from Excel at the cursor' : 'Read-only'}
                </span>
                <span className={s.grow} />
                <span role="status" aria-live="polite" className={s.hint}>{announce}</span>
                {editable && (
                  <>
                    {dirty.size > 0 && <Button variant="quiet" onClick={() => { setDirty(new Map()); setAdded([]); }}>Discard</Button>}
                    <Button variant="primary" onClick={save} disabled={saving || dirty.size === 0} count={dirty.size || undefined}>
                      {saving ? 'Saving…' : dirty.size ? 'Save' : 'Saved'}
                    </Button>
                  </>
                )}
              </div>
            </div>
          )}
        </>
      )}

      {sc.versionId && (
        <DriverDrawer open={!!driverRow} onClose={() => setDriverRow(null)} versionId={sc.versionId} departmentId={departmentId} row={driverRow} editable={editable && dirty.size === 0} onApplied={reload} />
      )}
      {sc.versionId && sc.locationId && (
        <StartPanel open={starting} onClose={() => setStarting(false)} locationId={sc.locationId} versionId={sc.versionId} departmentId={departmentId} departmentName={deptName} fiscalYear={sc.fiscalYear} onApplied={reload} />
      )}
      {sc.versionId && sc.locationId && (
        <CommentsDrawer open={!!commentRow} onClose={() => setCommentRow(null)} locationId={sc.locationId} versionId={sc.versionId} departmentId={departmentId} accountId={commentRow?.accountId ?? null}
          title={commentRow ? `${commentRow.accountNumber} ${commentRow.accountName}` : ''} canRequest={a?.scope === 'ALL'} onChanged={() => gridQ.refetch()} />
      )}
      <Dialog open={growRowKey !== null} onClose={() => setGrowRowKey(null)} title="Change the whole row by a %"
        actions={<><Button variant="quiet" onClick={() => setGrowRowKey(null)}>Cancel</Button><Button variant="primary" onClick={applyGrow} disabled={parsePercentToBps(growText) === null}>Apply</Button></>}>
        <Field label="Change %" help="Negative to reduce. Months keep their shape; the total ties to the cent.">
          <Input autoFocus inputMode="decimal" value={growText} onChange={(e) => setGrowText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && applyGrow()} />
        </Field>
      </Dialog>
      <Dialog open={addOpen} onClose={() => setAddOpen(false)} title="Add an account to this budget"
        actions={<><Button variant="quiet" onClick={() => setAddOpen(false)}>Cancel</Button><Button variant="primary" onClick={addRow} disabled={!addAccount}>Add row</Button></>}>
        <Field label="Account">
          <Select value={addAccount} onChange={(e) => setAddAccount(e.target.value)}>
            <option value="">Choose…</option>
            {(grid?.accounts ?? []).filter((x) => !rows.some((r) => r.accountId === x.id)).map((x) => (
              <option key={x.id} value={x.id}>{x.number} {x.name}{x.groupName ? ` · ${x.groupName}` : ''}</option>
            ))}
          </Select>
        </Field>
      </Dialog>
    </div>
  );
}
