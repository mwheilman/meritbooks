'use client';

import { useRef, useState, type ReactNode } from 'react';
import { Button, Check, Field, Popover, Select, Seg, Switch } from '@meritbooks/merit-ui';
import type { Basis, ColumnMode, CompareKind, Rounding, StatementKind } from '@/lib/reports/engine/types';
import type { EngineMeta } from './use-engine';
import type { ViewState } from './view-state';
import { PeriodControl } from './period-control';
import s from './engine.module.css';

const COMPARE_LABEL: Record<CompareKind, string> = { prior_period: 'Prior period', prior_year: 'Prior year', budget: 'Budget', forecast: 'Latest estimate' };
const COLUMN_LABEL: Record<ColumnMode, string> = {
  single: 'Total only', month: 'Months', quarter: 'Quarters', year: 'Years', company: 'Companies', location: 'Companies', department: 'Departments', class: 'Classes', job: 'Jobs',
};

export interface ControlsProps {
  state: ViewState;
  statement: StatementKind;
  meta: EngineMeta | null;
  onChange: (patch: Partial<ViewState>) => void;
  /** org-local today (period quick choices) */
  today: string;
}

function MultiPick<T extends string>({ label, options, value, onChange, allLabel, footer }: {
  label: string;
  options: Array<{ value: T; label: string; disabled?: boolean }>;
  value: T[];
  onChange: (v: T[]) => void;
  allLabel: string;
  footer?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const text = value.length === 0 ? allLabel : value.length === 1 ? options.find((o) => o.value === value[0])?.label ?? '1 selected' : `${value.length} selected`;
  return (
    <Field label={label}>
      <Button ref={ref} className={s.pickBtn} iconAfter="down" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((o) => !o)}>{text}</Button>
      <Popover open={open} onClose={() => setOpen(false)} anchorRef={ref} width={320} aria-label={label}>
        <div className={s.pickList}>
          {options.map((o) => (
            <div key={o.value} className={s.pickRow}>
              <Check
                label={o.label}
                disabled={o.disabled}
                checked={value.includes(o.value)}
                onChange={(e) => onChange(e.target.checked ? [...value, o.value] : value.filter((v) => v !== o.value))}
              />
            </div>
          ))}
          {options.length === 0 && <p className={s.empty} style={{ padding: '0 12px' }}>Nothing to choose.</p>}
        </div>
        <div className={s.pickFoot}>
          <Button variant="quiet" onClick={() => onChange([])}>{allLabel}</Button>
          {footer}
          <Button variant="primary" onClick={() => setOpen(false)}>Done</Button>
        </div>
      </Popover>
    </Field>
  );
}

/** The viewer toolbar: period, compare, columns, companies, basis, rounding, layout and toggles. */
export function Controls({ state, statement, meta, onChange, today }: ControlsProps) {
  const pit = statement === 'balance_sheet' || statement === 'trial_balance';
  const fixed = statement === 'equity_changes' || statement === 'trial_balance' || statement === 'gl_summary';
  const isLayoutStmt = statement === 'income_statement' || statement === 'balance_sheet';
  const columnModes: ColumnMode[] = fixed
    ? ['single']
    : statement === 'cash_flow'
      ? ['single', 'month', 'quarter', 'company']
      : pit ? ['single', 'month', 'quarter', 'year', 'company'] : ['single', 'month', 'quarter', 'year', 'company', 'department', 'class', 'job'];
  const compares: CompareKind[] = fixed ? [] : pit || statement === 'cash_flow' ? ['prior_period', 'prior_year'] : ['prior_period', 'prior_year', 'budget', 'forecast'];
  const layouts = (meta?.layouts ?? []).filter((l) => l.statement === (statement === 'balance_sheet' ? 'BS' : 'PNL'));
  const layoutValue = state.layout.kind === 'custom' ? state.layout.layoutId : state.layout.kind;

  return (
    <div className={s.toolbar} role="toolbar" aria-label="Report options">
      <PeriodControl
        value={{ preset: state.preset, asOf: state.asOf, start: state.start, end: state.end }}
        onChange={(p) => onChange(p)}
        today={today}
        pointInTime={pit}
      />

      {compares.length > 0 && (
        <MultiPick<CompareKind>
          label="Compare to"
          allLabel="No comparison"
          options={compares.map((c) => ({ value: c, label: COMPARE_LABEL[c] }))}
          value={state.compare}
          onChange={(v) => onChange({ compare: v })}
        />
      )}

      {columnModes.length > 1 && (
        <Field label="Columns" className={s.narrow}>
          <Select value={state.columns === 'location' ? 'company' : state.columns} onChange={(e) => onChange({ columns: e.target.value as ColumnMode })}>
            {columnModes.map((c) => <option key={c} value={c}>{COLUMN_LABEL[c]}</option>)}
          </Select>
        </Field>
      )}
      {(state.columns === 'month' || state.columns === 'quarter' || state.columns === 'year') && (
        <Field label="How many" className={s.narrow}>
          <Select value={String(state.columnCount ?? '')} onChange={(e) => onChange({ columnCount: e.target.value ? Number(e.target.value) : undefined })}>
            <option value="">Auto</option>
            {(state.columns === 'month' ? [3, 6, 12, 18, 24, 36] : state.columns === 'quarter' ? [4, 8, 12] : [2, 3, 5]).map((n) => <option key={n} value={n}>{n}</option>)}
          </Select>
        </Field>
      )}

      <MultiPick<string>
        label="Companies"
        allLabel="All companies"
        options={(meta?.companies ?? []).map((c) => ({ value: c.id, label: c.shortCode ? `${c.name} (${c.shortCode})` : c.name }))}
        value={state.companies}
        onChange={(v) => onChange({ companies: v })}
      />

      {!fixed && (meta?.companies.length ?? 0) > 1 && (
        <div className={s.tGroup} style={{ paddingBottom: 6 }}>
          <Switch label="Consolidate" checked={state.consolidate} onChange={(e) => onChange({ consolidate: e.target.checked })} />
        </div>
      )}

      {(meta?.departments.length ?? 0) > 0 && statement !== 'cash_flow' && (
        <MultiPick<string>
          label="Departments"
          allLabel="All departments"
          options={(meta?.departments ?? []).map((d) => ({ value: d.id, label: d.name }))}
          value={state.departmentIds}
          onChange={(v) => onChange({ departmentIds: v })}
        />
      )}

      {(meta?.classes.length ?? 0) > 0 && statement !== 'cash_flow' && (
        <MultiPick<string>
          label="Classes"
          allLabel="All classes"
          options={(meta?.classes ?? []).map((d) => ({ value: d.id, label: d.name }))}
          value={state.classIds}
          onChange={(v) => onChange({ classIds: v })}
        />
      )}

      {isLayoutStmt && (
        <Field label="Layout" className={s.narrow}>
          <Select
            value={layoutValue}
            onChange={(e) => {
              const v = e.target.value;
              onChange({ layout: v === 'standard' ? { kind: 'standard' } : v === 'ebitda' ? { kind: 'ebitda' } : { kind: 'custom', layoutId: v } });
            }}
          >
            <option value="standard">As reported</option>
            {statement === 'income_statement' && <option value="ebitda">Standard lines → EBITDA</option>}
            {layouts.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </Select>
        </Field>
      )}

      {statement === 'trial_balance' && (
        <Field label="Trial balance" className={s.narrow}>
          <Select value={state.tbMode} onChange={(e) => onChange({ tbMode: e.target.value as 'worksheet' | 'simple' })}>
            <option value="worksheet">Worksheet</option>
            <option value="simple">Adjusted only</option>
          </Select>
        </Field>
      )}

      <Field label="Basis" className={s.narrow}>
        <Select value={state.basis} onChange={(e) => onChange({ basis: e.target.value as Basis })}>
          <option value="ACCRUAL">Accrual</option>
          <option value="CASH" disabled={pit}>Cash{pit ? ' (P&L only)' : ''}</option>
          <option value="TAX">Tax</option>
          <option value="CUSTOM">Custom</option>
        </Select>
      </Field>

      <Field label="Show in">
        <Seg<Rounding>
          aria-label="Rounding"
          value={state.rounding}
          onChange={(r) => onChange({ rounding: r })}
          items={[{ value: 'cents', label: '$0.00' }, { value: 'units', label: '$' }, { value: 'thousands', label: '$K' }, { value: 'millions', label: '$M' }]}
        />
      </Field>

      <div className={s.tGrow} />
      <div className={s.toggles}>
        {isLayoutStmt && <Switch label="% of base" checked={state.commonSize} onChange={(e) => onChange({ commonSize: e.target.checked })} />}
        {state.columns === 'month' && statement === 'income_statement' && <Switch label="TTM column" checked={state.ttm} onChange={(e) => onChange({ ttm: e.target.checked })} />}
        <Switch label="Zero rows" checked={state.showZero} onChange={(e) => onChange({ showZero: e.target.checked })} />
      </div>
    </div>
  );
}
