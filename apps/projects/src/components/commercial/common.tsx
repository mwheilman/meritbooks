'use client';

import type { ReactNode } from 'react';
import { Button, InlineNotice, Status, money, shortDate } from '@meritbooks/merit-ui';
import { mark, type Mark } from '@/lib/commercial/labels';

/** A status word with its pip (never colour alone). */
export function Mk({ map, status }: { map: Readonly<Record<string, Mark>>; status: string | null | undefined }) {
  const x = mark(map, status);
  return <Status kind={x.kind} pip={x.pip}>{x.word}</Status>;
}

/** Table money: null (masked or not set) is an em dash, never $0. */
export function cm(v: number | null | undefined, decimals: 0 | 2 = 2): string {
  return v == null ? '—' : money(Number(v), { decimals });
}

/** "Oct 31" relative to today, or an em dash. */
export function day(d: string | null | undefined, today?: string): string {
  return d ? shortDate(d, today) : '—';
}

/** Days from a date to today (positive = past). */
export function daysSince(d: string | null | undefined, today: string): number | null {
  if (!d) return null;
  const a = Date.parse(`${d.slice(0, 10)}T00:00:00Z`);
  const b = Date.parse(`${today}T00:00:00Z`);
  return Number.isFinite(a) && Number.isFinite(b) ? Math.round((b - a) / 86_400_000) : null;
}

/** "3 days late" / "due in 2 days" / "due today". */
export function dueText(due: string | null | undefined, today: string): string | null {
  const n = daysSince(due, today);
  if (n === null) return null;
  if (n > 0) return `${n} ${n === 1 ? 'day' : 'days'} late`;
  if (n === 0) return 'due today';
  return `due in ${-n} ${n === -1 ? 'day' : 'days'}`;
}

/** The plain-language failure from a route, kept beside the thing that failed. */
export function Failure({ text, title = 'Not changed.' }: { text: string | null; title?: string }) {
  if (!text) return null;
  return <InlineNotice tone="neg" title={title} role="alert">{text}</InlineNotice>;
}

/** Section inside a drawer: thin rule, tracked label, body. */
export function DSection({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="ops-section" aria-label={title}>
      <div className="ops-section-h"><h3 className="t-section">{title}</h3><span className="sp" />{aside}</div>
      {children}
    </section>
  );
}

/** A row of actions; each disables while the request runs. */
export function Actions({ items, busy }: { items: ReadonlyArray<{ key: string; label: string; onClick: () => void; primary?: boolean; danger?: boolean; hidden?: boolean }>; busy: string | null }) {
  const shown = items.filter((i) => !i.hidden);
  if (!shown.length) return null;
  return (
    <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
      {shown.map((i) => (
        <Button key={i.key} variant={i.primary ? 'primary' : i.danger ? 'danger' : 'default'} disabled={busy !== null} onClick={i.onClick}>{busy === i.key ? 'Working…' : i.label}</Button>
      ))}
    </div>
  );
}

/** Whole dollars typed as "12,500" or "12500.50" → cents; null when blank or not a number. */
export function parseDollars(text: string): number | null {
  const t = text.trim().replace(/[$,\s]/g, '');
  if (!t) return null;
  if (!/^-?\d+(\.\d{1,2})?$/.test(t)) return null;
  return Math.round(Number(t) * 100);
}

/** Cents → editable dollars text. */
export function dollarsText(c: number | null | undefined): string {
  return c == null ? '' : (Number(c) / 100).toFixed(2).replace(/\.00$/, '');
}
