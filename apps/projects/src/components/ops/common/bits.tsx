'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { InlineNotice, Input, Select, Status, WidgetState } from '@meritbooks/merit-ui';
import type { Mark } from '@/lib/pm/ops/labels';
import type { JobOption } from '@/lib/pm/ops/scope';

/** A status word with its pip (never colour alone). */
export function StatusMark({ mark }: { mark: Mark }) {
  return <Status kind={mark.kind} pip={mark.pip}>{mark.word}</Status>;
}

/** The plain-language failure from a route, kept beside the thing that failed. */
export function Failure({ text, title = 'Not changed.' }: { text: string | null; title?: string }) {
  if (!text) return null;
  return <InlineNotice tone="neg" title={title} role="alert">{text}</InlineNotice>;
}

/** Panel body while the detail loads, or when it did not. */
export function DetailState({ loading, error, onRetry, what }: { loading: boolean; error: string | null; onRetry: () => void; what: string }) {
  if (error) return <WidgetState state={{ kind: 'error', title: `${what} did not load`, body: error, onRetry, retryLabel: 'Try again' }} />;
  if (loading) return <WidgetState state={{ kind: 'loading', label: `Loading the ${what.toLowerCase()}…`, lines: 4 }} />;
  return null;
}

/** Native select of jobs (type-ahead by first letters; keyboard-complete). */
export function JobSelect({ jobs, value, onChange, id, placeholder = 'Pick a job', disabled }: { jobs: ReadonlyArray<JobOption>; value: string; onChange: (id: string) => void; id?: string; placeholder?: string; disabled?: boolean }) {
  const multi = jobs.some((j) => j.company);
  return (
    <Select id={id} value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled}>
      <option value="">{placeholder}</option>
      {jobs.map((j) => (
        <option key={j.id} value={j.id}>
          {j.label}{j.customer ? ` · ${j.customer}` : ''}{multi && j.company ? ` · ${j.company}` : ''}
        </option>
      ))}
    </Select>
  );
}

/** Percent typed as "32" or "32.5" ↔ fraction 0.32 / 0.325. */
export function PctInput({ value, onChange, id, placeholder, max = 100, 'aria-label': ariaLabel }: { value: number | null; onChange: (v: number | null) => void; id?: string; placeholder?: string; max?: number; 'aria-label'?: string }) {
  const [text, setText] = useState(value == null ? '' : trimNum(value * 100));
  useEffect(() => {
    setText((t) => (parsePct(t) === value ? t : value == null ? '' : trimNum(value * 100)));
  }, [value]);
  return (
    <div style={{ position: 'relative' }}>
      <Input
        id={id}
        aria-label={ariaLabel}
        inputMode="decimal"
        value={text}
        placeholder={placeholder}
        onChange={(e) => {
          setText(e.target.value);
          const p = parsePct(e.target.value);
          if (p === null || p * 100 <= max) onChange(p);
        }}
        style={{ paddingRight: 28 }}
      />
      <span aria-hidden="true" className="ink-3" style={{ position: 'absolute', right: 10, top: 8 }}>%</span>
    </div>
  );
}

function trimNum(n: number): string {
  return String(Math.round(n * 100) / 100);
}

export function parsePct(s: string): number | null {
  const t = s.trim().replace(/%$/, '');
  if (!t) return null;
  if (!/^\d+(\.\d{0,4})?$/.test(t)) return null;
  return Math.round(Number(t) * 100) / 10000;
}

/** Number typed into a box (hours, minutes, quantities). */
export function parseNum(s: string): number | null {
  const t = s.trim().replace(/,/g, '');
  if (!t) return null;
  if (!/^-?\d+(\.\d+)?$/.test(t)) return null;
  return Number(t);
}

/** Section with a 2px Electric rule and a head line. */
export function Section({ title, meta, actions, children }: { title: ReactNode; meta?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="ops-section">
      <div className="ops-section-h">
        <h2 className="t-section">{title}</h2>
        {meta != null && <span className="t-cap">{meta}</span>}
        <span className="sp" />
        {actions}
      </div>
      {children}
    </section>
  );
}

/** In a multi-company view, writes need a company: this says so instead of guessing. */
export function PickCompanyNote({ what }: { what: string }) {
  return (
    <InlineNotice tone="info" title="Switch to one company to set this up.">
      {what} belong to one company. Use the company switcher in the bar, then come back here.
    </InlineNotice>
  );
}
