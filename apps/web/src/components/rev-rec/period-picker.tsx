'use client';

import { Button, Input } from '@meritbooks/merit-ui';

/** Shift 'YYYY-MM' by n months. */
export function shiftPeriod(periodKey: string, n: number): string {
  const [y, m] = periodKey.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7);
}

/** The month just ended — the one being closed. */
export function lastClosedPeriod(now = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
}

export function periodLabel(periodKey: string): string {
  const [y, m] = periodKey.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

/** Month selector: ‹ [month] › — keyboard reachable, no future months. */
export function PeriodPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const max = new Date().toISOString().slice(0, 7);
  return (
    <div className="row" role="group" aria-label="Period">
      <Button variant="quiet" iconOnly icon="left" aria-label="Previous month" onClick={() => onChange(shiftPeriod(value, -1))} />
      <Input
        type="month"
        value={value}
        max={max}
        aria-label="Month"
        style={{ width: 160 }}
        onChange={(e) => {
          if (/^\d{4}-\d{2}$/.test(e.target.value)) onChange(e.target.value);
        }}
      />
      <Button
        variant="quiet"
        iconOnly
        icon="right"
        aria-label="Next month"
        disabled={value >= max}
        onClick={() => onChange(shiftPeriod(value, 1))}
      />
    </div>
  );
}
