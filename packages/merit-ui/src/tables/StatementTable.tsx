'use client';

import type { ReactNode } from 'react';
import { NoteRef } from '../ai/Note';
import { cx, isDev } from '../cx';
import { moneyParts, type MoneyOptions } from '../format';

export interface StatementColumn {
  id: string;
  header: ReactNode;
  /** The current period sits on white (.cur). */
  current?: boolean;
  width?: number | string;
  /** Money formatting per column (decimals consistent per column, §8.1). */
  format?: MoneyOptions;
  /** Variance-% columns etc.: format the raw number yourself. */
  render?: (value: number) => ReactNode;
}

type Values = ReadonlyArray<number | null>;

export type StatementRow =
  | { kind: 'head'; label: ReactNode }
  | {
      kind: 'line' | 'elim';
      id?: string;
      label: ReactNode;
      /** One integer-cents value per column (null = blank). */
      values: Values;
      /** Superscript note ref. */
      note?: number;
      /** Favorable / unfavorable variance marker. */
      fu?: 'F' | 'U' | null;
      /** Variance ≥ threshold: set in 600. Indexes of columns to bold. */
      bold?: ReadonlyArray<number>;
    }
  | {
      kind: 'sub' | 'grand';
      id?: string;
      label: ReactNode;
      values: Values;
      note?: number;
      fu?: 'F' | 'U' | null;
      bold?: ReadonlyArray<number>;
      /**
       * Rows this total must equal, by id ({ id, sign: -1 } subtracts).
       * In development a total that doesn't tie throws — totals tie (§8.4).
       */
      sumOf?: ReadonlyArray<string | { id: string; sign: 1 | -1 }>;
    }
  | { kind: 'gap' };

export class StatementTieError extends Error {
  constructor(row: string, column: string, expected: number, actual: number) {
    super(`Statement total "${row}" does not tie in column "${column}": rows sum to ${actual}, total shows ${expected}.`);
    this.name = 'StatementTieError';
  }
}

/** Verify every sub/grand row with `sumOf` against its rows. Pure; throws StatementTieError. */
export function assertStatementTies(rows: ReadonlyArray<StatementRow>, columns: ReadonlyArray<StatementColumn>): void {
  const byId = new Map<string, Values>();
  for (const r of rows) if ('id' in r && r.id) byId.set(r.id, r.values);
  for (const r of rows) {
    if ((r.kind !== 'sub' && r.kind !== 'grand') || !r.sumOf) continue;
    columns.forEach((col, ci) => {
      if (col.render) return; // non-additive columns (percentages)
      const expected = r.values[ci];
      if (expected == null) return;
      let sum = 0;
      for (const ref of r.sumOf ?? []) {
        const id = typeof ref === 'string' ? ref : ref.id;
        const sign = typeof ref === 'string' ? 1 : ref.sign;
        const v = byId.get(id)?.[ci];
        if (v == null) continue;
        sum += sign * v;
      }
      if (sum !== expected) throw new StatementTieError(typeof r.label === 'string' ? r.label : (r.id ?? 'total'), typeof col.header === 'string' ? col.header : col.id, expected, sum);
    });
  }
}

/** A statement figure: parentheses for negatives, a hidden hanging paren otherwise so digits align. */
export function StatementFigure({ cents, format }: { cents: number; format?: MoneyOptions }) {
  const p = moneyParts(cents, { zeroAsDash: true, ...format, sign: 'parens' });
  return (
    <>
      {p.text}
      {!p.negative && <span className="hp">)</span>}
    </>
  );
}

export interface StatementTableProps {
  /** First header: units belong here ("In US dollars", "Hours"). */
  unitLabel: ReactNode;
  columns: ReadonlyArray<StatementColumn>;
  rows: ReadonlyArray<StatementRow>;
  /** Add the Note column (.nt). */
  notes?: boolean;
  /** Add the trailing F/U column. */
  fu?: boolean;
  /** Width of the label column (default: auto). */
  labelWidth?: number | string;
  /** "Totals tie: revenue − cost = gross profit …" — say so when it matters. */
  caption?: ReactNode;
  'aria-label'?: string;
  className?: string;
}

/**
 * .tbl.tbl-fs — the financial statement / job-cost summary / WIP. Electric
 * rule under the header, single Midnight rule over a subtotal, Electric
 * double rule under the grand total. Tabular, right-aligned, negatives in
 * parentheses, eliminations explicit.
 */
export function StatementTable({ unitLabel, columns, rows, notes = false, fu = false, labelWidth, caption, className, ...aria }: StatementTableProps) {
  if (isDev()) assertStatementTies(rows, columns);
  const span = 1 + (notes ? 1 : 0) + columns.length + (fu ? 1 : 0);
  return (
    <>
      <table className={cx('tbl', 'tbl-fs', className)} aria-label={aria['aria-label']}>
        <colgroup>
          <col style={labelWidth != null ? { width: labelWidth } : undefined} />
          {notes && <col style={{ width: 40 }} />}
          {columns.map((c) => (
            <col key={c.id} style={c.width != null ? { width: c.width } : undefined} />
          ))}
          {fu && <col style={{ width: 20 }} />}
        </colgroup>
        <thead>
          <tr>
            <th scope="col">{unitLabel}</th>
            {notes && (
              <th scope="col" className="nt">
                Note
              </th>
            )}
            {columns.map((c) => (
              <th key={c.id} scope="col" className={cx('n', c.current && 'cur')}>
                {c.header}
              </th>
            ))}
            {fu && (
              <th scope="col">
                <span className="sr">Favorable or unfavorable</span>
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            if (r.kind === 'head') {
              return (
                <tr key={i} className="fs-head">
                  <td colSpan={span}>{r.label}</td>
                </tr>
              );
            }
            if (r.kind === 'gap') {
              return (
                <tr key={i} className="fs-gap" aria-hidden="true">
                  <td colSpan={span} />
                </tr>
              );
            }
            const cls = r.kind === 'line' ? 'fs-line' : r.kind === 'elim' ? 'fs-line fs-elim' : r.kind === 'sub' ? 'fs-sub' : 'fs-grand';
            return (
              <tr key={r.id ?? i} className={cls}>
                <td>{r.label}</td>
                {notes && <td className="nt">{r.note != null && <NoteRef n={r.note} />}</td>}
                {columns.map((c, ci) => {
                  const v = r.values[ci];
                  return (
                    <td key={c.id} className={cx('n', c.current && 'cur', r.bold?.includes(ci) && 'b')}>
                      {v == null ? null : c.render ? c.render(v) : <StatementFigure cents={v} format={c.format} />}
                    </td>
                  );
                })}
                {fu && (
                  <td>
                    {r.fu === 'F' ? (
                      <span className="fu fu--f" aria-label="favorable">
                        F
                      </span>
                    ) : r.fu === 'U' ? (
                      <span className="fu fu--u" aria-label="unfavorable">
                        U
                      </span>
                    ) : (
                      <span className="fu ink-3" aria-hidden="true">
                        –
                      </span>
                    )}
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
      {caption != null && (
        <p className="t-cap" style={{ marginTop: 8 }}>
          {caption}
        </p>
      )}
    </>
  );
}
