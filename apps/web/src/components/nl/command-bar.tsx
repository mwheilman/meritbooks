'use client';

/**
 * Universal NL Command bar (FPB-nl-copilot Wave A, Dimensions 3/7/9).
 *
 * Mounted ONCE in (app)/layout.tsx → omnipresent on every authenticated screen.
 * Open with ⌘K / Ctrl-K (or "/" when not typing in a field). It classifies a
 * plain-English prompt via POST /api/nl/route and renders the routed lane in a
 * unified result panel. It posts nothing itself — the processing lane routes
 * approval through the existing gated engine routes.
 *
 * Keyboard model: ⌘K open · Esc close · ↑/↓ move through suggestions · ⏎ run.
 * Accessibility: role="dialog" aria-modal, focus moves to the input on open,
 * focus is trapped, Esc restores focus to the trigger.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Command, Loader2, Search, X, Sparkles, CornerDownLeft } from 'lucide-react';
import { ResultPanel } from './result-panel';
import type { NlRouteResult } from './intent';

const SUGGESTIONS: string[] = [
  'Accrue $4,200 of rent for July',
  'Why did OpEx jump last month?',
  'Open the bank feed',
  'What is cash on hand right now?',
  'Code the last 5 Home Depot charges to job materials',
  'Take me to invoices',
];

type Phase =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'result'; result: NlRouteResult };

export function CommandBar() {
  const [open, setOpen] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [activeIdx, setActiveIdx] = useState(-1);

  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const triggerFocusRef = useRef<Element | null>(null);

  const close = useCallback(() => {
    setOpen(false);
    setPhase({ kind: 'idle' });
    setPrompt('');
    setActiveIdx(-1);
    if (triggerFocusRef.current instanceof HTMLElement) triggerFocusRef.current.focus();
  }, []);

  const openBar = useCallback(() => {
    triggerFocusRef.current = document.activeElement;
    setOpen(true);
  }, []);

  // Global open shortcut: ⌘K / Ctrl-K anywhere; "/" only when not typing in a field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;
      if (meta && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        setOpen((v) => {
          if (!v) triggerFocusRef.current = document.activeElement;
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
          openBar();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, openBar]);

  // Focus the input on open.
  useEffect(() => {
    if (open) {
      const t = setTimeout(() => inputRef.current?.focus(), 20);
      return () => clearTimeout(t);
    }
  }, [open]);

  const run = useCallback(async (text: string) => {
    const q = text.trim();
    if (q.length < 2) return;
    setPhase({ kind: 'loading' });
    setActiveIdx(-1);
    try {
      const res = await fetch('/api/nl/route', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: q }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setPhase({ kind: 'error', message: data?.error ?? 'Could not route your request.' });
        return;
      }
      setPhase({ kind: 'result', result: data as NlRouteResult });
    } catch {
      setPhase({ kind: 'error', message: 'Could not reach the command router.' });
    }
  }, []);

  // In-dialog keyboard: Esc close, ↑/↓ through suggestions, ⏎ run, Tab trap.
  const onDialogKey = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    const showingSuggestions = phase.kind === 'idle';
    if (showingSuggestions && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      setActiveIdx((i) => {
        const n = SUGGESTIONS.length;
        if (e.key === 'ArrowDown') return (i + 1) % n;
        return i <= 0 ? n - 1 : i - 1;
      });
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (showingSuggestions && activeIdx >= 0) {
        const chosen = SUGGESTIONS[activeIdx];
        setPrompt(chosen);
        run(chosen);
      } else {
        run(prompt);
      }
      return;
    }
    if (e.key === 'Tab') {
      // Minimal focus trap: keep focus inside the dialog.
      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (!focusable || focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  }, [phase.kind, activeIdx, prompt, run, close]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-start justify-center bg-black/60 backdrop-blur-sm px-4 pt-[12vh]"
      onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Natural language command"
        onKeyDown={onDialogKey}
        className="w-full max-w-2xl overflow-hidden rounded-2xl border border-slate-700 bg-slate-900 shadow-2xl"
        style={{ fontFamily: 'var(--font-jakarta, inherit)' }}
      >
        {/* Input row */}
        <div className="flex items-center gap-3 border-b border-slate-800 px-4 py-3">
          {phase.kind === 'loading'
            ? <Loader2 size={18} className="shrink-0 animate-spin text-emerald-400" />
            : <Search size={18} className="shrink-0 text-slate-500" />}
          <input
            ref={inputRef}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Ask or command… e.g. “accrue $4,200 rent for Coho” or “why did OpEx jump?”"
            aria-label="Command prompt"
            className="flex-1 bg-transparent text-[15px] text-white placeholder:text-slate-500 focus:outline-none"
          />
          <button
            onClick={() => run(prompt)}
            disabled={prompt.trim().length < 2 || phase.kind === 'loading'}
            className="inline-flex items-center gap-1 rounded-md bg-emerald-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-emerald-500 disabled:opacity-40 transition-colors"
          >
            Run <CornerDownLeft size={12} />
          </button>
          <button onClick={close} aria-label="Close" className="text-slate-500 hover:text-slate-300"><X size={18} /></button>
        </div>

        {/* Body */}
        <div className="max-h-[55vh] overflow-y-auto px-4 py-4">
          {phase.kind === 'idle' && (
            <div>
              <p className="mb-2 flex items-center gap-1.5 text-2xs uppercase tracking-wider text-slate-500">
                <Sparkles size={12} className="text-emerald-400" /> Try
              </p>
              <ul className="space-y-1">
                {SUGGESTIONS.map((s, i) => (
                  <li key={s}>
                    <button
                      onMouseEnter={() => setActiveIdx(i)}
                      onClick={() => { setPrompt(s); run(s); }}
                      className={`w-full rounded-lg px-3 py-2 text-left text-sm transition-colors ${
                        i === activeIdx ? 'bg-slate-800 text-white' : 'text-slate-300 hover:bg-slate-800/60'
                      }`}
                    >
                      {s}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {phase.kind === 'loading' && (
            <div className="flex items-center gap-2 py-6 text-sm text-slate-400">
              <Loader2 size={15} className="animate-spin" /> Routing your request…
            </div>
          )}

          {phase.kind === 'error' && (
            <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-3 text-sm text-rose-200">
              {phase.message}
            </div>
          )}

          {phase.kind === 'result' && <ResultPanel result={phase.result} onDone={close} />}
        </div>

        {/* Footer hint */}
        <div className="flex items-center gap-4 border-t border-slate-800 px-4 py-2 text-2xs text-slate-500">
          <span className="inline-flex items-center gap-1"><Command size={11} />K to toggle</span>
          <span>↑↓ to browse</span>
          <span>⏎ to run</span>
          <span>Esc to close</span>
          <span className="ml-auto text-slate-600">AI proposes · you approve · nothing posts on its own</span>
        </div>
      </div>
    </div>
  );
}
