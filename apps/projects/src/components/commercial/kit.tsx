'use client';

import { useCallback, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { Keyhints, Pip, WidgetState, useListKeynav, type PipKind } from '@meritbooks/merit-ui';

/**
 * The commercial screens' shared table and bits (Wave C). Every row opens on click, Enter or
 * Space; ↑/↓ move between rows; the page's one primary table also takes J/K/Enter through the
 * hotkey registry (`keys`). Empty states say what to do; money cells are tabular and right-aligned.
 */

export interface Col<T> {
  key: string;
  head: ReactNode;
  cell: (r: T) => ReactNode;
  /** Numeric (right-aligned, tabular). */
  n?: boolean;
  width?: number;
  /** Left out entirely (a money column the caller may not see). */
  hidden?: boolean;
  foot?: ReactNode;
}

export interface CmTableProps<T> {
  rows: ReadonlyArray<T>;
  cols: ReadonlyArray<Col<T>>;
  rowKey: (r: T) => string;
  onOpen?: (r: T) => void;
  /** Shown instead of the table when there are no rows. */
  empty: { title: string; body?: ReactNode; action?: ReactNode };
  /** J/K/Enter through the hotkey registry — one table per page. */
  keys?: boolean;
  label: string;
  activeId?: string | null;
  rowTone?: (r: T) => 'neg' | 'warn' | null;
  /** Show the footer row (cols' `foot`). */
  foot?: boolean;
}

export function CmTable<T>({ rows, cols, rowKey, onOpen, empty, keys = false, label, activeId, rowTone, foot }: CmTableProps<T>) {
  const shown = cols.filter((c) => !c.hidden);
  const body = useRef<HTMLTableSectionElement>(null);
  const open = useCallback((i: number) => { const r = rows[i]; if (r && onOpen) onOpen(r); }, [rows, onOpen]);
  const nav = useListKeynav({ count: rows.length, onOpen: open, enabled: keys && !!onOpen, owner: `cm-table:${label}` });
  if (rows.length === 0) return <div className="mp-table"><WidgetState state={{ kind: 'empty', title: empty.title, body: empty.body, action: empty.action }} /></div>;

  const onKey = (e: KeyboardEvent<HTMLTableRowElement>, i: number) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(i); }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const trs = body.current?.querySelectorAll<HTMLTableRowElement>('tr[data-row]');
      const next = trs?.[e.key === 'ArrowDown' ? i + 1 : i - 1];
      if (next) { next.focus(); nav.setActiveIndex(e.key === 'ArrowDown' ? i + 1 : i - 1); }
    }
  };

  return (
    <div className="mp-table" style={{ overflowX: 'auto' }}>
      <table className="tbl tbl-q tbl-q--compact" aria-label={label}>
        <thead><tr>{shown.map((c) => <th key={c.key} className={c.n ? 'n' : undefined} style={c.width ? { width: c.width } : undefined}>{c.head}</th>)}</tr></thead>
        <tbody ref={body}>
          {rows.map((r, i) => {
            const id = rowKey(r);
            const tone = rowTone?.(r) ?? null;
            const p = keys ? nav.rowProps(i) : null;
            return (
              <tr
                key={id}
                data-row
                ref={p?.ref}
                data-active={p?.['data-active'] || activeId === id || undefined}
                className={['q-row', tone === 'neg' ? 'is-neg' : tone === 'warn' ? 'is-warn' : null].filter(Boolean).join(' ')}
                tabIndex={onOpen ? 0 : undefined}
                aria-selected={activeId === id || undefined}
                onClick={onOpen ? () => onOpen(r) : undefined}
                onKeyDown={onOpen ? (e) => onKey(e, i) : undefined}
                style={onOpen ? { cursor: 'pointer' } : undefined}
              >
                {shown.map((c) => <td key={c.key} className={c.n ? 'n tnum' : undefined}>{c.cell(r)}</td>)}
              </tr>
            );
          })}
        </tbody>
        {foot && <tfoot><tr className="q-row b">{shown.map((c) => <td key={c.key} className={c.n ? 'n tnum' : undefined}>{c.foot ?? null}</td>)}</tr></tfoot>}
      </table>
    </div>
  );
}

/** The keys a screen answers to, printed under its table (every action has a key). */
export function TableKeys({ extra = [] }: { extra?: ReadonlyArray<{ chord: string; label: string }> }) {
  return <Keyhints className="ops-noprint" hints={[{ chord: 'j k', label: 'Move' }, { chord: 'enter', label: 'Open' }, ...extra]} />;
}

/** A stage strip (Pencil → Pencil sent → Certified → Final): pip shape + word, never colour alone. */
export function Stepper({ steps, index, blocked, label }: { steps: ReadonlyArray<{ label: string }>; index: number; blocked?: boolean; label: string }) {
  return (
    <ol className="cm-steps" aria-label={label}>
      {steps.map((s, i) => {
        const kind: PipKind = i < index ? 'ready' : i === index ? (blocked ? 'blocked' : 'track') : 'closed';
        return (
          <li key={s.label} className={i === index ? 'is-current' : undefined} aria-current={i === index ? 'step' : undefined}>
            <Pip kind={kind} /> <span>{s.label}{i === index && blocked ? ' — returned' : ''}</span>
          </li>
        );
      })}
    </ol>
  );
}

/** A count with its word: "3 open". */
export function nWord(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
}

/** SCREAMING_SNAKE → "Screaming snake". */
export function words(s: string | null | undefined): string {
  if (!s) return '—';
  const t = s.replace(/_/g, ' ').toLowerCase();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/** Hours / quantities: up to `d` decimals, em dash for null. */
export function qty(n: number | string | null | undefined, d = 1): string {
  if (n == null || n === '') return '—';
  const v = Number(n);
  return Number.isFinite(v) ? v.toLocaleString('en-US', { maximumFractionDigits: d }) : '—';
}
