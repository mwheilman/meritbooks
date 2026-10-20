'use client';

import { StatementTable, money, pct, type StatementColumn, type StatementRow } from '@meritbooks/merit-ui';
import type { G702, G703Line } from '@/lib/pm/money/aia';

export interface G703Row {
  id: string;
  /** A: item number */
  item: number;
  /** B: description of work */
  description: string;
  line: G703Line;
}

const PCT_SCALE = 1_000_000;

/** AIA G703 continuation sheet, columns A–I. Money columns tie to the grand total. */
export function G703Table({ rows, caption, label = 'AIA G703 continuation sheet' }: { rows: ReadonlyArray<G703Row>; caption?: React.ReactNode; label?: string }) {
  const columns: StatementColumn[] = [
    { id: 'c', header: <>C<span className="l2">Scheduled value</span></>, width: 120 },
    { id: 'd', header: <>D<span className="l2">From previous</span></>, width: 120 },
    { id: 'e', header: <>E<span className="l2">This period</span></>, width: 120, current: true },
    { id: 'f', header: <>F<span className="l2">Stored now</span></>, width: 112, current: true },
    { id: 'g', header: <>G<span className="l2">Completed &amp; stored</span></>, width: 128 },
    { id: 'pc', header: <>G ÷ C<span className="l2">%</span></>, width: 72, render: (v) => pct(v / PCT_SCALE) },
    { id: 'h', header: <>H<span className="l2">Balance to finish</span></>, width: 120 },
    { id: 'i', header: <>I<span className="l2">Retainage</span></>, width: 112 },
  ];
  const body: StatementRow[] = rows.map((r) => ({
    kind: 'line',
    id: r.id,
    label: <><span className="code">{r.item}</span> {r.description}{r.line.error ? <span className="field-error" style={{ display: 'block' }}>{G703_ERROR_WORDS[r.line.error]}</span> : null}</>,
    values: [
      r.line.scheduled, r.line.previous, r.line.thisPeriod, r.line.stored, r.line.completedStored,
      r.line.pct == null ? null : Math.round(r.line.pct * PCT_SCALE), r.line.balance, r.line.retainageWorkToDate + r.line.retainageStoredToDate,
    ],
    bold: r.line.error ? [4] : undefined,
  }));
  const t = rows.reduce(
    (s, r) => ({
      c: s.c + r.line.scheduled, d: s.d + r.line.previous, e: s.e + r.line.thisPeriod, f: s.f + r.line.stored, g: s.g + r.line.completedStored,
      h: s.h + r.line.balance, i: s.i + r.line.retainageWorkToDate + r.line.retainageStoredToDate,
    }),
    { c: 0, d: 0, e: 0, f: 0, g: 0, h: 0, i: 0 },
  );
  body.push({
    kind: 'grand', label: 'Totals', sumOf: rows.map((r) => r.id),
    values: [t.c, t.d, t.e, t.f, t.g, t.c > 0 ? Math.round((t.g / t.c) * PCT_SCALE) : null, t.h, t.i],
  });
  return <StatementTable aria-label={label} unitLabel="A · B  Item · in US dollars" columns={columns} rows={body} labelWidth={240} caption={caption} />;
}

export const G703_ERROR_WORDS: Readonly<Record<NonNullable<G703Line['error']>, string>> = {
  PCT_RANGE: 'Percent complete is 0 to 100.',
  NEGATIVE: 'Below zero: less than already billed.',
  OVER_SCHEDULED: 'Completed plus stored is more than the scheduled value.',
};

/** AIA G702 application summary, lines 1–9. 3 = 1 + 2, 6 = 4 − 5, 8 = 6 − 7, 9 = 3 − 6. */
export function G702Table({ s, applicationNo, caption }: { s: G702; applicationNo: number | null; caption?: React.ReactNode }) {
  const columns: StatementColumn[] = [{ id: 'v', header: applicationNo ? `Application #${applicationNo}` : 'This application', current: true, width: 160 }];
  const rows: StatementRow[] = [
    { kind: 'line', id: 'l1', label: '1  Original contract sum', values: [s.originalContract] },
    { kind: 'line', id: 'l2', label: '2  Net change by change orders', values: [s.netChangeByCo] },
    { kind: 'sub', id: 'l3', label: '3  Contract sum to date', sumOf: ['l1', 'l2'], values: [s.contractSumToDate] },
    { kind: 'gap' },
    { kind: 'line', id: 'l4', label: '4  Total completed and stored to date', values: [s.completedStoredToDate] },
    { kind: 'line', id: 'l5a', label: '5a  Retainage on completed work', values: [s.retainageWork] },
    { kind: 'line', id: 'l5b', label: '5b  Retainage on stored materials', values: [s.retainageStored] },
    { kind: 'line', id: 'l5', label: '5  Total retainage', values: [s.retainageTotal] },
    { kind: 'sub', id: 'l6', label: '6  Total earned less retainage', sumOf: ['l4', { id: 'l5', sign: -1 }], values: [s.earnedLessRetainage] },
    { kind: 'line', id: 'l7', label: '7  Less previous certificates for payment', values: [s.previousCertificates] },
    { kind: 'grand', id: 'l8', label: '8  Current payment due', sumOf: ['l6', { id: 'l7', sign: -1 }], values: [s.currentPaymentDue] },
    { kind: 'gap' },
    { kind: 'sub', id: 'l9', label: '9  Balance to finish, including retainage', sumOf: ['l3', { id: 'l6', sign: -1 }], values: [s.balanceToFinishInclRetainage] },
  ];
  return (
    <StatementTable
      aria-label="AIA G702 application for payment"
      unitLabel="G702 · in US dollars"
      columns={columns}
      rows={rows}
      caption={caption ?? (s.retainageTotal !== s.retainageWork + s.retainageStored
        ? `Line 5 is retainage actually held (${money(s.retainageTotal)}); 5a + 5b is the contract rate before the retention cap.`
        : 'Totals tie.')}
    />
  );
}
