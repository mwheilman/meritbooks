'use client';

import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import { cx, isDev } from '../cx';
import type { MoneyOptions } from '../format';
import { Conf } from '../primitives/Meter';
import { Tag } from '../primitives/Status';
import { assertEvidenceTies, evidenceSum, formatEvidenceValue, type EvidenceRow } from './evidence';

/* ------------------------------------------------------------------ linking
   A figure carries a superscript .nref; hovering/focusing either the ref or
   the note lights both (Sky + Electric), 200ms.                             */

interface NoteLinkValue {
  lit: string | null;
  setLit: (id: string | null) => void;
}

const NoteLinkContext = createContext<NoteLinkValue | null>(null);

/** Wrap a statement + its notes column so refs, figures and notes light together. */
export function NoteLinkProvider({ children }: { children: ReactNode }) {
  const [lit, setLit] = useState<string | null>(null);
  const value = useMemo(() => ({ lit, setLit }), [lit]);
  return <NoteLinkContext.Provider value={value}>{children}</NoteLinkContext.Provider>;
}

/** Hover/focus handlers + lit state for anything tied to note `id`. */
export function useNoteLink(id: string | number | undefined) {
  const ctx = useContext(NoteLinkContext);
  const key = id == null ? null : String(id);
  const lit = ctx != null && key != null && ctx.lit === key;
  const on = () => key != null && ctx?.setLit(key);
  const off = () => ctx?.setLit(null);
  return { lit, bind: { onMouseEnter: on, onMouseLeave: off, onFocus: on, onBlur: off } };
}

/** The superscript note reference beside a figure: <NoteRef n={2} />. */
export function NoteRef({ n, href }: { n: number | string; href?: string }) {
  const { lit, bind } = useNoteLink(n);
  return (
    <a className={cx('nref', lit && 'is-lit')} href={href ?? `#note-${n}`} data-note={n} aria-label={`See note ${n}`} {...bind}>
      {n}
    </a>
  );
}

/* ------------------------------------------------------------------ evidence */

export interface EvidenceProps {
  rows: ReadonlyArray<EvidenceRow>;
  /** The ledger's closing line. `value` is optional: omitted, the total is computed. */
  total: { label: string; value?: number };
  /** money (integer cents, default) or count (integers). */
  unit?: 'money' | 'count';
  /** Money formatting, e.g. { decimals: 0 } for whole dollars. */
  format?: MoneyOptions;
  className?: string;
}

/**
 * .ev — the dotted-leader ledger whose lines SUM to the claim. In development
 * a total that doesn't tie throws (EvidenceMismatchError); in production it is
 * logged and the computed sum is what renders — the page never shows a total
 * its own rows contradict.
 */
export function Evidence({ rows, total, unit = 'money', format, className }: EvidenceProps) {
  let shown: number;
  if (total.value == null) {
    shown = evidenceSum(rows);
  } else if (isDev()) {
    shown = assertEvidenceTies(rows, total.value, total.label);
  } else {
    shown = evidenceSum(rows);
    if (shown !== total.value) {
      // eslint-disable-next-line no-console
      console.error(`[merit-ui] Evidence for "${total.label}" does not tie (${shown} vs ${total.value}); rendering the computed sum.`);
    }
  }
  return (
    <ul className={cx('ev', className)}>
      {rows.map((r, i) => (
        <li key={i}>
          {r.label}
          <span className="dl" />
          <span className="v">{formatEvidenceValue(r.value, unit, format)}</span>
        </li>
      ))}
      <li className="ev-total">
        {total.label}
        <span className="dl" />
        <span className="v">{formatEvidenceValue(shown, unit, format)}</span>
      </li>
    </ul>
  );
}

/* ------------------------------------------------------------------ basis / why */

export interface BasisProps {
  /** 0–100 → meter + number; 'exact' for posted figures. */
  confidence?: number | 'exact';
  /** What it rests on ("612 GL lines · 3 price letters", "posted GL"). */
  items?: ReadonlyArray<ReactNode>;
  className?: string;
}

/** .basis — confidence and what the claim rests on. */
export function Basis({ confidence, items = [], className }: BasisProps) {
  return (
    <div className={cx('basis', className)}>
      {confidence === 'exact' ? (
        <span>
          <b>Exact</b>
        </span>
      ) : confidence != null ? (
        <span>
          <Conf score={confidence} /> confidence
        </span>
      ) : null}
      {items.map((it, i) => (
        <span key={i}>{it}</span>
      ))}
    </div>
  );
}

export interface WhyItem {
  text: ReactNode;
  /** Outlined square = a reason against. */
  against?: boolean;
}

/** .why — filled Electric square = for, outlined = against (with sr words, never shape alone). */
export function Why({ items, className }: { items: ReadonlyArray<WhyItem>; className?: string }) {
  return (
    <ul className={cx('why', className)}>
      {items.map((it, i) => (
        <li key={i} className={it.against ? 'against' : undefined}>
          <span className="sr">{it.against ? 'Against: ' : 'For: '}</span>
          {it.text}
        </li>
      ))}
    </ul>
  );
}

/* ------------------------------------------------------------------ note */

export interface NoteProps {
  /** Note number (outlined Syne numeral). Also the link key for NoteRef. */
  n: number;
  /** Kind label: "Margin", "Revenue", "Timing" → "Note 1 · Margin". */
  kind: string;
  /** The claim. */
  title: ReactNode;
  /** One or two sentences under the claim. */
  children?: ReactNode;
  /** Evidence ledger (sums to the claim). */
  evidence?: EvidenceProps;
  basis?: BasisProps;
  /** One or two actions (quiet buttons/links). */
  actions?: ReactNode;
  headingLevel?: 3 | 4 | 5;
  className?: string;
}

/**
 * .note — the AI speaks like an auditor's footnote: claim, evidence that
 * sums, basis/confidence, one or two actions. Never a chat bubble.
 */
export function Note({ n, kind, title, children, evidence, basis, actions, headingLevel = 4, className }: NoteProps) {
  const { lit, bind } = useNoteLink(n);
  const H = `h${headingLevel}` as 'h3' | 'h4' | 'h5';
  return (
    <article className={cx('note', lit && 'is-lit', className)} id={`note-${n}`} data-note={n} {...bind}>
      <div className="note-top">
        <span className="note-no" aria-hidden="true">
          {n}
        </span>
        <div>
          <div className="note-kind">
            Note {n} · {kind}
          </div>
          <H className="note-title">{title}</H>
        </div>
      </div>
      {children != null && <p>{children}</p>}
      {evidence && <Evidence {...evidence} />}
      {basis && <Basis {...basis} />}
      {actions != null && <div className="note-acts">{actions}</div>}
    </article>
  );
}

export interface NotesProps {
  title?: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
}

/** .notes — the Canvas notes column beside a statement. */
export function Notes({ title = 'Notes', hint = 'Hover a note or a figure', children, className }: NotesProps) {
  return (
    <aside className={cx('notes', className)} aria-label="Notes to the figures">
      <div className="notes-head">
        <h3 className="t-section">{title}</h3>
        {hint != null && <span className="t-cap">{hint}</span>}
      </div>
      {children}
    </aside>
  );
}

export interface NotePanelProps {
  /** "AI suggestion" by default. Proposed state is visibly provisional. */
  tag?: ReactNode;
  confidence?: number;
  title?: ReactNode;
  why?: ReadonlyArray<WhyItem>;
  evidence?: EvidenceProps;
  basis?: ReadonlyArray<ReactNode>;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
}

/** .note.note--panel — the AI's reasoning inside a side panel (Sky, 3px Electric inset). */
export function NotePanel({ tag = 'AI suggestion', confidence, title, why, evidence, basis, actions, children, className }: NotePanelProps) {
  return (
    <div className={cx('note', 'note--panel', className)}>
      <div className="row row--between">
        <Tag tone="ai">{tag}</Tag>
        {confidence != null && <Conf score={confidence} />}
      </div>
      {title != null && (
        <h4 className="note-title" style={{ marginTop: 8 }}>
          {title}
        </h4>
      )}
      {children != null && <p>{children}</p>}
      {why && why.length > 0 && <Why items={why} />}
      {evidence && <Evidence {...evidence} />}
      {basis && basis.length > 0 && <Basis items={basis} />}
      {actions != null && <div className="note-acts">{actions}</div>}
    </div>
  );
}
