'use client';

/**
 * Small client kit the industry-depth screens share (dealer, manufacturing, flooring, design,
 * development): a board read that refetches after every write, its loading / error state, the
 * write path (toast + refetch), a file picker that hands back text, and a few cells.
 */
import { useCallback, useRef, useState, type ReactNode } from 'react';
import { Button, InlineNotice, WidgetState, shortDate, useQuery } from '@meritbooks/merit-ui';
import { useStore } from './useStore';

export interface Board<T> {
  data: T | null;
  error: string | null;
  isLoading: boolean;
  reload: () => void;
}

/** GET a board; `reload()` refetches (writes call it). Pass null to wait. */
export function useBoard<T>(url: string | null): Board<T> {
  const [v, setV] = useState(0);
  const q = useQuery<T>(url, undefined, { key: String(v), scope: false });
  const reload = useCallback(() => setV((x) => x + 1), []);
  return { data: q.data, error: q.error, isLoading: q.isLoading, reload };
}

/** Loading or failed board (null when the data is there). */
export function BoardState<T>({ b, what }: { b: Board<T>; what: string }) {
  if (b.error) return <WidgetState state={{ kind: 'error', title: `${what} did not load`, body: b.error, onRetry: b.reload, retryLabel: 'Try again' }} />;
  if (b.isLoading && !b.data) return <WidgetState state={{ kind: 'loading', label: `Loading ${what.toLowerCase()}…`, lines: 5 }} />;
  return null;
}

/** POST an op, toast the verb, refetch the board. Returns the data or null (the failure stays on screen). */
export function useDo(reload: () => void) {
  const { act, busy, error, failure, clearFailure } = useStore();
  const run = useCallback(
    async <T,>(key: string, url: string, body: unknown, ok: string | null | ((d: T) => string | null)): Promise<T | null> => {
      const r = await act<T>(key, 'post', url, body, ok ?? (() => null));
      reload();
      return r.error ? null : r.data;
    },
    [act, reload],
  );
  return { run, busy, error, failure, clearFailure };
}

/** A file input that reads the chosen file as text (CSV, TSV, XML, fixed-width). */
export function FilePick({ label, accept, onText, disabled, maxBytes = 15_000_000 }: { label: string; accept: string; onText: (name: string, text: string) => void; disabled?: boolean; maxBytes?: number }) {
  const ref = useRef<HTMLInputElement>(null);
  const [err, setErr] = useState<string | null>(null);
  return (
    <span className="btn-row">
      <input
        ref={ref}
        type="file"
        accept={accept}
        className="sr"
        aria-label={label}
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (!f) return;
          if (f.size > maxBytes) { setErr(`That file is ${Math.round(f.size / 1_000_000)} MB; the limit is ${Math.round(maxBytes / 1_000_000)} MB.`); return; }
          setErr(null);
          f.text().then((t) => onText(f.name, t), () => setErr('That file could not be read.'));
        }}
      />
      <Button disabled={disabled} onClick={() => ref.current?.click()}>{label}</Button>
      {err && <span className="neg t-cap" role="alert">{err}</span>}
    </span>
  );
}

/** A plain note when the screen needs one company (writes go to one company). */
export function OneCompany({ what }: { what: string }) {
  return (
    <InlineNotice tone="info" title="Switch to one company.">
      {what} belong to one company. Pick it in the company switcher in the bar.
    </InlineNotice>
  );
}

export function Empty({ title, body, action }: { title: string; body: ReactNode; action?: ReactNode }) {
  return <WidgetState state={{ kind: 'empty', title, body, action }} />;
}

/** Quantity with up to two decimals, tabular. */
export function qty(n: number | string | null | undefined, unit?: string | null): string {
  if (n == null || n === '') return '—';
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  const s = Math.abs(v - Math.round(v)) < 1e-9 ? Math.round(v).toLocaleString('en-US') : v.toLocaleString('en-US', { maximumFractionDigits: 2 });
  return unit ? `${s} ${unit}` : s;
}

export function pctText(n: number | string | null | undefined, digits = 1): string {
  if (n == null || n === '') return '—';
  const v = Number(n);
  return Number.isFinite(v) ? `${(v * 100).toFixed(digits)}%` : '—';
}

export function day(iso: string | null | undefined, today: string): string {
  return iso ? shortDate(iso.slice(0, 10), today) : '—';
}

/** Dollars typed in a box → integer cents (exact; null when empty or unreadable). */
export function centsFrom(text: string): number | null {
  const s = text.trim().replace(/[$,\s]/g, '');
  if (!s) return null;
  if (!/^-?\d+(\.\d{0,2})?$/.test(s)) return null;
  const neg = s.startsWith('-');
  const [w = '0', f = ''] = s.replace('-', '').split('.');
  const c = Number(w) * 100 + Number((f + '00').slice(0, 2));
  return neg ? -c : c;
}
