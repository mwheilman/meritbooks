'use client';

/**
 * PeriodControl — the viewer's period picker, isolated behind a small value/onChange
 * contract so it can be swapped for the shared picker (`components/period/**`) when that
 * lands without touching the rest of the viewer.
 *
 * Quick choices mirror the shared picker's presets: This month, Last month, Quarter to
 * date, Last quarter, Year to date, Last year, Trailing 12 months, Custom. "Last quarter" /
 * "Last year" are expressed as the engine's fiscal period CONTAINING a date one quarter /
 * one year back, so they follow the tenant's fiscal year without the client knowing it.
 * Balance-sheet style (point-in-time) statements get "End of …" choices instead.
 */
import { Field, Input, Select } from '@meritbooks/merit-ui';
import { addMonths, monthEnd } from '@/lib/reports/engine/periods';
import type { PeriodPreset } from '@/lib/reports/engine/types';
import s from './engine.module.css';

export interface PeriodValue {
  preset: PeriodPreset;
  asOf: string;
  start?: string;
  end?: string;
}

export interface PeriodControlProps {
  value: PeriodValue;
  onChange: (patch: Partial<PeriodValue>) => void;
  /** org-local today, 'YYYY-MM-DD' */
  today: string;
  /** balance sheet / trial balance: choose an as-of date, not a span */
  pointInTime: boolean;
}

type QuickKey =
  | 'this_month' | 'last_month' | 'qtd' | 'last_quarter' | 'ytd' | 'last_year' | 'ttm'
  | 'month_of' | 'quarter_of' | 'year_of' | 'custom'
  | 'pit_today' | 'pit_last_month' | 'pit_last_quarter' | 'pit_last_year' | 'pit_month_of' | 'pit_quarter_of' | 'pit_year_of';

interface Quick {
  key: QuickKey;
  label: string;
  /** the state this choice sets; null = keep the current date (the "… containing" choices) */
  set: (today: string, cur: PeriodValue) => PeriodValue;
  /** shows a date input */
  needsDate?: boolean;
}

const back = (today: string, months: number) => monthEnd(addMonths(`${today.slice(0, 7)}-01`, -months));

const SPAN: Quick[] = [
  { key: 'this_month', label: 'This month (to date)', set: (t) => ({ preset: 'mtd', asOf: t }) },
  { key: 'last_month', label: 'Last month', set: (t) => ({ preset: 'month', asOf: back(t, 1) }) },
  { key: 'qtd', label: 'Quarter to date', set: (t) => ({ preset: 'qtd', asOf: t }) },
  { key: 'last_quarter', label: 'Last quarter', set: (t) => ({ preset: 'quarter', asOf: back(t, 3) }) },
  { key: 'ytd', label: 'Year to date', set: (t) => ({ preset: 'ytd', asOf: t }) },
  { key: 'last_year', label: 'Last fiscal year', set: (t) => ({ preset: 'year', asOf: back(t, 12) }) },
  { key: 'ttm', label: 'Trailing 12 months', set: (t) => ({ preset: 'ttm', asOf: back(t, 1) }) },
  { key: 'month_of', label: 'Month containing…', set: (_t, c) => ({ preset: 'month', asOf: c.asOf }), needsDate: true },
  { key: 'quarter_of', label: 'Quarter containing…', set: (_t, c) => ({ preset: 'quarter', asOf: c.asOf }), needsDate: true },
  { key: 'year_of', label: 'Fiscal year containing…', set: (_t, c) => ({ preset: 'year', asOf: c.asOf }), needsDate: true },
  { key: 'custom', label: 'Custom range…', set: (_t, c) => ({ preset: 'custom', asOf: c.end ?? c.asOf, start: c.start ?? `${c.asOf.slice(0, 7)}-01`, end: c.end ?? c.asOf }) },
];

const POINT: Quick[] = [
  { key: 'pit_today', label: 'Today', set: (t) => ({ preset: 'month', asOf: t }) },
  { key: 'pit_last_month', label: 'End of last month', set: (t) => ({ preset: 'month', asOf: back(t, 1) }) },
  { key: 'pit_last_quarter', label: 'End of last quarter', set: (t) => ({ preset: 'quarter', asOf: back(t, 3) }) },
  { key: 'pit_last_year', label: 'End of last fiscal year', set: (t) => ({ preset: 'year', asOf: back(t, 12) }) },
  { key: 'pit_month_of', label: 'End of the month of…', set: (_t, c) => ({ preset: 'month', asOf: c.asOf }), needsDate: true },
  { key: 'pit_quarter_of', label: 'End of the quarter of…', set: (_t, c) => ({ preset: 'quarter', asOf: c.asOf }), needsDate: true },
  { key: 'pit_year_of', label: 'End of the fiscal year of…', set: (_t, c) => ({ preset: 'year', asOf: c.asOf }), needsDate: true },
];

/** Which quick choice the current value is (PURE; exported for tests). */
export function quickKeyFor(v: PeriodValue, today: string, pointInTime: boolean): QuickKey {
  const list = pointInTime ? POINT : SPAN;
  for (const q of list) {
    if (q.needsDate || q.key === 'custom') continue;
    const target = q.set(today, v);
    if (target.preset === v.preset && target.asOf === v.asOf) return q.key;
  }
  if (pointInTime) return v.preset === 'quarter' ? 'pit_quarter_of' : v.preset === 'year' ? 'pit_year_of' : 'pit_month_of';
  switch (v.preset) {
    case 'custom': return 'custom';
    case 'quarter': return 'quarter_of';
    case 'year': return 'year_of';
    case 'mtd': return 'this_month';
    case 'qtd': return 'qtd';
    case 'ytd': return 'ytd';
    case 'ttm': return 'ttm';
    default: return 'month_of';
  }
}

export function PeriodControl({ value, onChange, today, pointInTime }: PeriodControlProps) {
  const list = pointInTime ? POINT : SPAN;
  const key = quickKeyFor(value, today, pointInTime);
  const q = list.find((x) => x.key === key) ?? list[0];
  // A relative choice that exactly matches today needs no date; anything else shows it (a
  // shared link "YTD through 30 Jun" keeps its date visible and editable).
  const target = q.needsDate || q.key === 'custom' ? null : q.set(today, value);
  const exact = !!target && target.preset === value.preset && target.asOf === value.asOf;
  const showDate = !exact;
  return (
    <div className={s.tGroup}>
      <Field label="Period" className={s.narrow}>
        <Select
          value={key}
          onChange={(e) => {
            const next = list.find((x) => x.key === e.target.value);
            if (next) onChange(next.set(today, value));
          }}
        >
          {list.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}
        </Select>
      </Field>
      {value.preset === 'custom' && !pointInTime ? (
        <>
          <Field label="From"><Input type="date" className={s.dateIn} value={value.start ?? ''} max={value.end} onChange={(e) => onChange({ start: e.target.value || undefined })} /></Field>
          <Field label="To"><Input type="date" className={s.dateIn} value={value.end ?? ''} min={value.start} onChange={(e) => onChange({ end: e.target.value || undefined, asOf: e.target.value || value.asOf })} /></Field>
        </>
      ) : showDate ? (
        <Field label={pointInTime ? 'Date' : value.preset.endsWith('td') ? 'Through' : 'Containing'}>
          <Input type="date" className={s.dateIn} value={value.asOf} onChange={(e) => e.target.value && onChange({ asOf: e.target.value, ...(pointInTime ? { end: e.target.value } : {}) })} />
        </Field>
      ) : null}
    </div>
  );
}
