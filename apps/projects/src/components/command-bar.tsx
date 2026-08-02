'use client';

/**
 * Ask-your-portfolio command bar (global ⌘K / Ctrl-K palette).
 *
 * Mounted ONCE in (app)/layout.tsx → omnipresent on every authenticated screen.
 * Renders nothing until opened. Open with ⌘K / Ctrl-K anywhere, or "/" when
 * focus isn't in a field. It POSTs a plain-English prompt to /api/nl/query
 * (owned by another builder) and renders the cited answer with drill-through
 * links. It is read-only analytics — it never posts or mutates anything.
 *
 * Keyboard model: ⌘K / Ctrl-K toggle · "/" open (not while typing) · Esc close ·
 * ↑/↓ move through suggestions · ⏎ run · Tab trapped inside the dialog.
 * A11y: role="dialog" aria-modal, focus moves to the input on open, focus is
 * trapped while open, focus returns to the previously-focused element on close.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import {
  ArrowUpRight, Command, CornerDownLeft, Link2, Loader2, Search, Sparkles, X,
} from 'lucide-react';
import clsx from 'clsx';

/* -------------------------------------------------------------- API contract -- */
// POST /api/nl/query  body: { prompt }
// 200 → NlQueryResponse. Non-200 → { code } (see ERROR_MESSAGE).
interface Citation {
  label: string;
  href?: string;
}
interface NlQueryResponse {
  answer: string;
  metric: string;
  params: Record<string, unknown>;
  rows: unknown[];
  citations: Citation[];
  drilldownHref?: string;
}
interface NlQueryError {
  code?: string;
}

const ERROR_MESSAGE: Record<string, string> = {
  NO_ORG: "We couldn't tell which workspace you're in. Reload and try again.",
  NO_API_KEY: "AI answers aren't configured for this workspace yet.",
  GATEWAY_ERROR: 'The answer service is busy right now — try that again in a moment.',
};
const GENERIC_ERROR = 'Something went wrong answering that — try again in a moment.';

/* --------------------------------------------------------------- suggestions -- */
// Mirror the server metric catalog so a click maps cleanly to a known metric.
const SUGGESTIONS: string[] = [
  'Which jobs are projected to lose money?',
  'Which cost codes are over budget?',
  'How much retainage is outstanding?',
  'Which gates are blocking billing?',
  'Show me the margin on the Riverside job',
];

/* --------------------------------------------------------------------- phase -- */
type Phase =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'result'; result: NlQueryResponse; prompt: string };

/* ---------------------------------------------------------------- row helpers - */
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function isPrimitive(v: unknown): v is string | number | boolean {
  const t = typeof v;
  return t === 'string' || t === 'number' || t === 'boolean';
}
function cellText(v: unknown): string {
  if (v == null || v === '') return '—';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '—';
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (typeof v === 'string') return v;
  return '—';
}
const humanize = (k: string) => k.replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2');

// Build a small, safe table model from opaque rows. Returns null if the rows
// aren't a set of primitive-valued objects we can render honestly.
function tableModel(rows: unknown[]): { cols: string[]; data: Record<string, unknown>[] } | null {
  const objs = rows.filter(isRecord).slice(0, 8);
  if (objs.length === 0) return null;
  const cols: string[] = [];
  for (const row of objs) {
    for (const k of Object.keys(row)) {
      if (!cols.includes(k) && isPrimitive(row[k])) cols.push(k);
    }
  }
  if (cols.length === 0) return null;
  return { cols: cols.slice(0, 5), data: objs };
}

/* ==================================================================== bar ==== */
export function CommandBar() {
  const [open, setOpen] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [activeIdx, setActiveIdx] = useState(-1);

  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<Element | null>(null);

  const close = useCallback(() => {
    setOpen(false);
    setPhase({ kind: 'idle' });
    setPrompt('');
    setActiveIdx(-1);
    if (returnFocusRef.current instanceof HTMLElement) returnFocusRef.current.focus();
  }, []);

  // Global open shortcut: ⌘K / Ctrl-K anywhere; "/" only when not in a field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;
      if (meta && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        setOpen((v) => {
          if (!v) returnFocusRef.current = document.activeElement;
          return !v;
        });
        return;
      }
      if (e.key === '/' && !open) {
        const el = document.activeElement as HTMLElement | null;
        const tag = el?.tagName;
        const typing = tag === 'INPUT' || tag === 'TEXTAREA' || el?.isContentEditable;
        if (!typing) {
          e.preventDefault();
          returnFocusRef.current = document.activeElement;
          setOpen(true);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  // Move focus to the input on open.
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => inputRef.current?.focus(), 20);
    return () => clearTimeout(t);
  }, [open]);

  const run = useCallback(async (text: string) => {
    const q = text.trim();
    if (q.length < 2) return;
    setPhase({ kind: 'loading' });
    setActiveIdx(-1);
    try {
      const res = await fetch('/api/nl/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: q }),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => null)) as NlQueryError | null;
        const message = (err?.code && ERROR_MESSAGE[err.code]) || GENERIC_ERROR;
        setPhase({ kind: 'error', message });
        return;
      }
      const data = (await res.json()) as NlQueryResponse;
      setPhase({ kind: 'result', result: data, prompt: q });
    } catch {
      setPhase({ kind: 'error', message: "We couldn't reach the answer service — check your connection and retry." });
    }
  }, []);

  const chooseSuggestion = useCallback((s: string) => {
    setPrompt(s);
    run(s);
  }, [run]);

  // In-dialog keyboard: Esc close · ↑/↓ suggestions · ⏎ run · Tab trap.
  const onDialogKey = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    const showingSuggestions = phase.kind === 'idle';
    if (showingSuggestions && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      setActiveIdx((i) => {
        const n = SUGGESTIONS.length;
        return e.key === 'ArrowDown' ? (i + 1) % n : i <= 0 ? n - 1 : i - 1;
      });
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (showingSuggestions && activeIdx >= 0) chooseSuggestion(SUGGESTIONS[activeIdx]);
      else run(prompt);
      return;
    }
    if (e.key === 'Tab') {
      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (!focusable || focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  }, [phase.kind, activeIdx, prompt, run, chooseSuggestion, close]);

  if (!open) return null;

  const loading = phase.kind === 'loading';

  return (
    <div
      className="fixed inset-0 z-[100] flex items-start justify-center bg-black/70 px-4 pt-[12vh] backdrop-blur-sm"
      onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Ask your portfolio"
        onKeyDown={onDialogKey}
        className="w-full max-w-2xl overflow-hidden rounded-2xl border border-surface-800 bg-surface-900 font-sans shadow-2xl shadow-black/50"
      >
        {/* Input row */}
        <div className="flex items-center gap-3 border-b border-surface-800 px-4 py-3.5">
          {loading
            ? <Loader2 size={18} className="shrink-0 animate-spin text-brand-400" />
            : <Search size={18} className="shrink-0 text-slate-500" />}
          <input
            ref={inputRef}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Ask your portfolio — e.g. which jobs are projected to lose money?"
            aria-label="Ask your portfolio"
            className="min-w-0 flex-1 bg-transparent text-[15px] text-white placeholder:text-slate-500 focus:outline-none"
          />
          <button
            onClick={() => run(prompt)}
            disabled={prompt.trim().length < 2 || loading}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-brand-600 px-2.5 py-1 text-xs font-medium text-white transition-colors hover:bg-brand-500 disabled:opacity-40"
          >
            Ask <CornerDownLeft size={12} />
          </button>
          <button onClick={close} aria-label="Close" className="shrink-0 text-slate-500 transition-colors hover:text-slate-300">
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div className="max-h-[58vh] overflow-y-auto px-4 py-4">
          {phase.kind === 'idle' && (
            <Suggestions activeIdx={activeIdx} setActiveIdx={setActiveIdx} onPick={chooseSuggestion} />
          )}

          {phase.kind === 'loading' && (
            <div className="space-y-2.5 py-1">
              <div className="flex items-center gap-2 text-sm text-slate-400">
                <Loader2 size={14} className="animate-spin" /> Reading the portfolio…
              </div>
              <div className="h-3 w-3/4 animate-pulse rounded bg-surface-800" />
              <div className="h-3 w-full animate-pulse rounded bg-surface-800" />
              <div className="h-3 w-1/2 animate-pulse rounded bg-surface-800" />
            </div>
          )}

          {phase.kind === 'error' && (
            <div className="rounded-lg border border-danger/30 bg-danger/10 px-3.5 py-3 text-sm text-danger-fg" role="alert">
              {phase.message}
            </div>
          )}

          {phase.kind === 'result' && <Answer result={phase.result} onNavigate={close} />}
        </div>

        {/* Footer hint */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-surface-800 px-4 py-2 text-2xs text-slate-500">
          <span className="inline-flex items-center gap-1"><Command size={11} />K to toggle</span>
          <span>↑↓ to browse</span>
          <span>⏎ to ask</span>
          <span>Esc to close</span>
          <span className="ml-auto inline-flex items-center gap-1 text-slate-600">
            <Sparkles size={11} className="text-ai-fg" /> Answers cite the data they came from
          </span>
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------- suggestions -- */
function Suggestions({
  activeIdx, setActiveIdx, onPick,
}: {
  activeIdx: number;
  setActiveIdx: (i: number) => void;
  onPick: (s: string) => void;
}) {
  return (
    <div>
      <p className="mb-2 flex items-center gap-1.5 text-2xs uppercase tracking-[0.14em] text-slate-500">
        <Sparkles size={12} className="text-ai-fg" /> Try asking
      </p>
      <ul className="space-y-1">
        {SUGGESTIONS.map((s, i) => (
          <li key={s}>
            <button
              onMouseEnter={() => setActiveIdx(i)}
              onClick={() => onPick(s)}
              className={clsx(
                'w-full rounded-lg px-3 py-2 text-left text-sm transition-colors',
                i === activeIdx ? 'bg-surface-800 text-white' : 'text-slate-300 hover:bg-surface-850',
              )}
            >
              {s}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* -------------------------------------------------------------------- answer - */
function Answer({ result, onNavigate }: { result: NlQueryResponse; onNavigate: () => void }) {
  const { answer, citations, rows, drilldownHref } = result;
  const table = Array.isArray(rows) ? tableModel(rows) : null;
  const validCitations = Array.isArray(citations)
    ? citations.filter((c): c is Citation => !!c && typeof c.label === 'string')
    : [];

  return (
    <div className="space-y-4">
      {/* The answer — prominent, plain language. Also carries abstain text. */}
      <p className="text-[15px] leading-relaxed text-white">
        {answer?.trim() ? answer : "I couldn't find an answer for that. Try one of the suggested questions."}
      </p>

      {/* Optional compact table over the supporting rows. */}
      {table && (
        <div className="overflow-hidden rounded-xl border border-surface-800">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-surface-800 bg-surface-850">
                {table.cols.map((c) => (
                  <th key={c} className="px-3 py-2 text-2xs font-medium uppercase tracking-wider text-slate-500">
                    {humanize(c)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.data.map((row, ri) => (
                <tr key={ri} className="border-b border-surface-800/70 last:border-0">
                  {table.cols.map((c) => {
                    const v = row[c];
                    return (
                      <td
                        key={c}
                        className={clsx(
                          'px-3 py-2 text-slate-200',
                          typeof v === 'number' && 'num text-right tabular-nums',
                        )}
                      >
                        {cellText(v)}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Citations — the provenance chips. Linked ones navigate + close. */}
      {validCitations.length > 0 && (
        <div>
          <p className="mb-1.5 text-2xs uppercase tracking-[0.14em] text-slate-500">Cited from</p>
          <div className="flex flex-wrap gap-1.5">
            {validCitations.map((c, i) =>
              c.href ? (
                <Link
                  key={i}
                  href={c.href}
                  onClick={onNavigate}
                  className="inline-flex items-center gap-1.5 rounded-md border border-surface-700 bg-surface-850 px-2.5 py-1 text-xs text-slate-300 transition-colors hover:border-brand-500/50 hover:text-brand-300"
                >
                  <Link2 size={11} className="text-slate-500" />
                  {c.label}
                </Link>
              ) : (
                <span
                  key={i}
                  className="inline-flex items-center gap-1.5 rounded-md border border-surface-800 bg-surface-850 px-2.5 py-1 text-xs text-slate-400"
                >
                  <Link2 size={11} className="text-slate-600" />
                  {c.label}
                </span>
              ),
            )}
          </div>
        </div>
      )}

      {/* Drill-through into the underlying screen. */}
      {drilldownHref && (
        <Link
          href={drilldownHref}
          onClick={onNavigate}
          className="inline-flex items-center gap-1.5 text-sm text-brand-400 transition-colors hover:text-brand-300"
        >
          View details <ArrowUpRight size={14} />
        </Link>
      )}
    </div>
  );
}
