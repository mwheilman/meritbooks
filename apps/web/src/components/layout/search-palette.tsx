'use client';

/**
 * GLOBAL SEARCH PALETTE — the ⌘/ (and ⌘K) "find anything" overlay.
 *
 * A command-palette shell over the SEARCH / KNOWLEDGE lane (POST /api/search →
 * runSearch, matrix modality M13). It is a thin, read-only client: it debounces
 * the query, posts it to the existing backend, renders the grouped/ranked results
 * the server returns, and deep-links to the record on select. It never fabricates
 * or re-ranks — the server owns retrieval, scoring, and the grounded "why matched"
 * headline; this component only presents it and handles keyboard navigation.
 *
 * Company scope: when a specific company is active in the header, its
 * `location_id` is passed to the backend so transactional results (bank txns,
 * invoices, bills, JEs) are narrowed to that entity — a SUB-filter within the
 * tenant RLS already isolates. Masters (vendors/customers/accounts) stay org-wide.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { clsx } from 'clsx';
import {
  Search,
  Loader2,
  CornerDownLeft,
  ArrowUp,
  ArrowDown,
  BookOpen,
  Receipt,
  FileText,
  FileInput,
  Building2,
  Users,
  Landmark,
  Sparkles,
} from 'lucide-react';
import { useActiveCompany } from '@/lib/hooks/use-active-company';
import { isSpecificCompany } from '@/lib/company-scope';
import type { HeadlineSegment, SearchResponse, SearchResult, SearchType } from '@/lib/search/types';

const DEBOUNCE_MS = 220;
const MIN_QUERY = 2;

const TYPE_ICON: Record<SearchType, typeof Search> = {
  journal_entry: BookOpen,
  bank_transaction: Receipt,
  invoice: FileText,
  bill: FileInput,
  vendor: Building2,
  customer: Users,
  account: Landmark,
};

interface SearchPaletteProps {
  open: boolean;
  onClose: () => void;
}

/** Grounded "why it matched" snippet — highlights the matched spans in emerald. */
function Headline({ segments }: { segments: HeadlineSegment[] }) {
  return (
    <span className="truncate">
      {segments.map((s, i) =>
        s.hit ? (
          <mark key={i} className="bg-transparent text-brand-400 font-medium">
            {s.text}
          </mark>
        ) : (
          <span key={i} className="text-slate-500">
            {s.text}
          </span>
        ),
      )}
    </span>
  );
}

export function SearchPalette({ open, onClose }: SearchPaletteProps) {
  const router = useRouter();
  const { activeCompanyId, activeCompany } = useActiveCompany();

  const [query, setQuery] = useState('');
  const [response, setResponse] = useState<SearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);

  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const reqSeq = useRef(0);

  // Flatten the grouped response into a single ordered list for keyboard nav.
  const flat = useMemo<SearchResult[]>(
    () => (response ? response.groups.flatMap((g) => g.results) : []),
    [response],
  );

  const scopedLocationId = isSpecificCompany(activeCompanyId) ? activeCompanyId : null;

  // Reset transient state each time the palette opens; focus the input.
  useEffect(() => {
    if (!open) return;
    setActiveIndex(0);
    const t = setTimeout(() => inputRef.current?.focus(), 10);
    return () => clearTimeout(t);
  }, [open]);

  // Debounced fetch. Aborts the in-flight request and ignores stale responses so
  // fast typing can never render an out-of-order result set.
  useEffect(() => {
    if (!open) return;
    const q = query.trim();
    if (q.length < MIN_QUERY) {
      abortRef.current?.abort();
      setResponse(null);
      setError(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);
    const handle = setTimeout(async () => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      const seq = ++reqSeq.current;
      try {
        const res = await fetch('/api/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: controller.signal,
          body: JSON.stringify({
            query: q,
            ...(scopedLocationId ? { location_id: scopedLocationId } : {}),
          }),
        });
        const body = await res.json();
        if (seq !== reqSeq.current) return; // a newer request superseded this one
        if (!res.ok) {
          setError(typeof body?.error === 'string' ? body.error : 'Search failed');
          setResponse(null);
        } else {
          setResponse(body as SearchResponse);
          setActiveIndex(0);
        }
      } catch (e) {
        if ((e as Error).name === 'AbortError') return;
        if (seq !== reqSeq.current) return;
        setError('Network error — check your connection and try again.');
        setResponse(null);
      } finally {
        if (seq === reqSeq.current) setLoading(false);
      }
    }, DEBOUNCE_MS);

    return () => clearTimeout(handle);
  }, [query, open, scopedLocationId]);

  const go = useCallback(
    (result: SearchResult) => {
      onClose();
      router.push(result.href);
    },
    [onClose, router],
  );

  // Keep the highlighted row scrolled into view.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${activeIndex}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, flat.length]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
      return;
    }
    if (flat.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => (i + 1) % flat.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => (i - 1 + flat.length) % flat.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const target = flat[activeIndex];
      if (target) go(target);
    }
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center px-4 pt-[12vh]"
      role="dialog"
      aria-modal="true"
      aria-label="Search"
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm animate-fade-in" onClick={onClose} />

      {/* Panel */}
      <div className="relative w-full max-w-2xl rounded-2xl border border-slate-800 bg-surface-900 shadow-2xl overflow-hidden animate-slide-up">
        {/* Input row */}
        <div className="flex items-center gap-3 border-b border-slate-800 px-4">
          {loading ? (
            <Loader2 size={18} className="shrink-0 text-brand-400 animate-spin" />
          ) : (
            <Search size={18} className="shrink-0 text-slate-500" />
          )}
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Search transactions, invoices, bills, vendors, JEs…"
            className="w-full bg-transparent py-4 text-[15px] text-slate-100 placeholder:text-slate-600 focus:outline-none"
            autoComplete="off"
            spellCheck={false}
          />
          {scopedLocationId && activeCompany && (
            <span className="shrink-0 rounded-md bg-brand-500/10 px-2 py-1 text-2xs font-medium text-brand-400">
              {activeCompany.shortCode}
            </span>
          )}
        </div>

        {/* Results / states */}
        <div ref={listRef} className="max-h-[52vh] overflow-y-auto py-2">
          {/* Idle prompt */}
          {query.trim().length < MIN_QUERY && (
            <div className="px-4 py-10 text-center">
              <p className="text-sm text-slate-400">Search everything in your books.</p>
              <p className="mt-1 text-xs text-slate-600">
                Try a vendor, an amount like <span className="font-mono text-slate-500">$1,240</span>, an invoice #, or
                a date.
              </p>
            </div>
          )}

          {/* Error */}
          {query.trim().length >= MIN_QUERY && error && (
            <div className="px-4 py-8 text-center">
              <p className="text-sm text-red-400">{error}</p>
              <button
                onClick={() => setQuery((q) => q + ' ')}
                className="mt-3 rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-300 hover:bg-white/[0.03]"
              >
                Retry
              </button>
            </div>
          )}

          {/* Empty */}
          {query.trim().length >= MIN_QUERY && !error && !loading && response && flat.length === 0 && (
            <div className="px-4 py-10 text-center">
              <p className="text-sm text-slate-400">No results for “{response.query}”.</p>
              <p className="mt-1 text-xs text-slate-600">Try a different spelling, an amount, or a reference number.</p>
            </div>
          )}

          {/* Loading (first query, nothing to show yet) */}
          {query.trim().length >= MIN_QUERY && loading && !response && !error && (
            <div className="flex items-center justify-center gap-2 px-4 py-10 text-sm text-slate-500">
              <Loader2 size={16} className="animate-spin" />
              Searching…
            </div>
          )}

          {/* Grouped results */}
          {!error &&
            response &&
            flat.length > 0 &&
            response.groups.map((group) => {
              const Icon = TYPE_ICON[group.type];
              return (
                <div key={group.type} className="mb-1">
                  <div className="flex items-center gap-2 px-4 pb-1 pt-2 text-2xs font-semibold uppercase tracking-wider text-slate-500">
                    <Icon size={12} />
                    {group.label}
                  </div>
                  {group.results.map((result) => {
                    const idx = flat.indexOf(result);
                    const isActive = idx === activeIndex;
                    return (
                      <button
                        key={`${result.type}:${result.id}`}
                        data-idx={idx}
                        onMouseEnter={() => setActiveIndex(idx)}
                        onClick={() => go(result)}
                        className={clsx(
                          'flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors',
                          isActive ? 'bg-brand-500/10' : 'hover:bg-white/[0.03]',
                        )}
                      >
                        <div
                          className={clsx(
                            'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg',
                            isActive ? 'bg-brand-500/20 text-brand-400' : 'bg-slate-800 text-slate-400',
                          )}
                        >
                          <Icon size={15} />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-medium text-slate-100">{result.title}</div>
                          <div className="mt-0.5 truncate text-xs text-slate-500">
                            {result.headline ? <Headline segments={result.headline} /> : result.subtitle}
                          </div>
                        </div>
                        {isActive && <CornerDownLeft size={14} className="shrink-0 text-slate-600" />}
                      </button>
                    );
                  })}
                </div>
              );
            })}
        </div>

        {/* Footer hint bar */}
        <div className="flex items-center justify-between border-t border-slate-800 px-4 py-2 text-2xs text-slate-600">
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-1">
              <ArrowUp size={11} />
              <ArrowDown size={11} />
              navigate
            </span>
            <span className="flex items-center gap-1">
              <CornerDownLeft size={11} />
              open
            </span>
            <span>esc close</span>
          </div>
          {response?.aiAssisted && (
            <span className="flex items-center gap-1 text-indigo-400">
              <Sparkles size={11} />
              AI-assisted
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
