'use client';

/**
 * SEARCH / KNOWLEDGE lane (matrix modality M13) — results surface.
 *
 * A plain-English "find anything" across the owned ledger. Posts to
 * POST /api/search (read-only, RLS-scoped) and renders ranked results grouped
 * by object type. Ships here as a dedicated page rather than editing the global
 * command bar: the command bar routes to the (owned-by-another-wave) /api/nl
 * classifier, so wiring search into it would require touching components/nl,
 * which this wave must not modify. A follow-up can add "search" as an nl intent
 * that deep-links here.
 *
 * States: idle (suggestions) · loading · error · empty · grouped results.
 */

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import {
  Search, Loader2, X, Sparkles, ArrowRight, Receipt, FileText, Landmark,
  BookOpen, Truck, Users, Wallet,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

type SearchType =
  | 'journal_entry' | 'bank_transaction' | 'invoice' | 'bill'
  | 'vendor' | 'customer' | 'account';

interface HeadlineSegment {
  text: string;
  hit: boolean;
}
interface SearchResult {
  type: SearchType;
  id: string;
  title: string;
  subtitle: string;
  amountCents: number | null;
  date: string | null;
  href: string;
  snippet: string;
  headline: HeadlineSegment[] | null;
  score: number;
}
interface SearchGroup {
  type: SearchType;
  label: string;
  results: SearchResult[];
}
interface SearchResponse {
  query: string;
  groups: SearchGroup[];
  total: number;
  aiAssisted: boolean;
}

const TYPE_ICON: Record<SearchType, LucideIcon> = {
  journal_entry: BookOpen,
  bank_transaction: Landmark,
  invoice: FileText,
  bill: Receipt,
  vendor: Truck,
  customer: Users,
  account: Wallet,
};

const TYPE_LABEL: Record<SearchType, string> = {
  journal_entry: 'Journal entries',
  bank_transaction: 'Bank transactions',
  invoice: 'Invoices',
  bill: 'Bills',
  vendor: 'Vendors',
  customer: 'Customers',
  account: 'GL accounts',
};

const SUGGESTIONS = [
  'Home Depot charges over $500 last month',
  'Invoice 1042',
  'Bills from Acme',
  'Journal entries in July 2026',
  '$4,200 rent',
  'Accounts payable',
];

type Phase =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'done'; data: SearchResponse };

export default function SearchPage() {
  return (
    <Suspense fallback={<div className="mx-auto w-full max-w-4xl px-4 py-8 text-sm text-slate-400">Loading search…</div>}>
      <SearchInner />
    </Suspense>
  );
}

function SearchInner() {
  const params = useSearchParams();
  const initial = params.get('q') ?? '';
  const [query, setQuery] = useState(initial);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [typeFilter, setTypeFilter] = useState<SearchType | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const runSearch = useCallback(async (raw: string) => {
    const q = raw.trim();
    if (q.length < 2) {
      setPhase({ kind: 'idle' });
      return;
    }
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setTypeFilter(null);
    setPhase({ kind: 'loading' });
    try {
      const res = await fetch('/api/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: q }),
        signal: controller.signal,
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setPhase({ kind: 'error', message: data?.error ?? 'Search failed.' });
        return;
      }
      setPhase({ kind: 'done', data: data as SearchResponse });
    } catch (e) {
      if ((e as Error)?.name === 'AbortError') return;
      setPhase({ kind: 'error', message: 'Could not reach search.' });
    }
  }, []);

  // Debounced search on query change.
  useEffect(() => {
    const t = setTimeout(() => runSearch(query), 350);
    return () => clearTimeout(t);
  }, [query, runSearch]);

  // Focus on mount.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const allGroups = phase.kind === 'done' ? phase.data.groups : [];
  const total = phase.kind === 'done' ? phase.data.total : 0;
  const aiAssisted = phase.kind === 'done' ? phase.data.aiAssisted : false;

  // Selecting a type chip narrows the visible groups to that one lane.
  const grouped = useMemo(
    () => (typeFilter ? allGroups.filter((g) => g.type === typeFilter) : allGroups),
    [allGroups, typeFilter],
  );

  const headerCount = useMemo(() => {
    if (phase.kind !== 'done') return null;
    return `${total} result${total === 1 ? '' : 's'} across ${allGroups.length} categor${allGroups.length === 1 ? 'y' : 'ies'}`;
  }, [phase.kind, total, allGroups.length]);

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-8" style={{ fontFamily: 'var(--font-jakarta, inherit)' }}>
      <header className="mb-6">
        <h1 className="flex items-center gap-2 text-2xl font-semibold text-white">
          <Search size={22} className="text-emerald-400" /> Search
        </h1>
        <p className="mt-1 text-sm text-slate-400">
          Find anything across the ledger — journal entries, bank transactions, invoices, bills, vendors, customers, and accounts.
        </p>
      </header>

      {/* Search box */}
      <div className="flex items-center gap-3 rounded-xl border border-slate-700 bg-slate-900 px-4 py-3 shadow-lg focus-within:border-emerald-500/60">
        {phase.kind === 'loading'
          ? <Loader2 size={18} className="shrink-0 animate-spin text-emerald-400" />
          : <Search size={18} className="shrink-0 text-slate-500" />}
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="e.g. “Home Depot charges over $500 last month” or “invoice 1042”"
          aria-label="Search the ledger"
          className="flex-1 bg-transparent text-[15px] text-white placeholder:text-slate-500 focus:outline-none"
        />
        {query && (
          <button onClick={() => { setQuery(''); setPhase({ kind: 'idle' }); inputRef.current?.focus(); }}
            aria-label="Clear" className="text-slate-500 hover:text-slate-300"><X size={16} /></button>
        )}
      </div>

      {aiAssisted && (
        <p className="mt-2 flex items-center gap-1.5 text-xs text-indigo-300">
          <Sparkles size={12} /> Interpreted with AI assist
        </p>
      )}

      {/* Body */}
      <div className="mt-6">
        {phase.kind === 'idle' && (
          <div>
            <p className="mb-3 text-2xs uppercase tracking-wider text-slate-500">Try searching for</p>
            <div className="flex flex-wrap gap-2">
              {SUGGESTIONS.map((s) => (
                <button key={s} onClick={() => setQuery(s)}
                  className="rounded-full border border-slate-700 bg-slate-800/60 px-3 py-1.5 text-sm text-slate-300 hover:border-emerald-500/50 hover:text-white transition-colors">
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {phase.kind === 'loading' && (
          <div className="flex items-center gap-2 py-10 text-sm text-slate-400">
            <Loader2 size={16} className="animate-spin" /> Searching the ledger…
          </div>
        )}

        {phase.kind === 'error' && (
          <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
            {phase.message}
          </div>
        )}

        {phase.kind === 'done' && total === 0 && (
          <div className="rounded-xl border border-slate-800 bg-slate-900/60 px-6 py-12 text-center">
            <Search size={28} className="mx-auto mb-3 text-slate-600" />
            <p className="text-sm text-slate-300">No results for “{phase.data.query}”.</p>
            <p className="mt-1 text-xs text-slate-500">Try a vendor name, an amount like $4,200, an invoice number, or a month.</p>
          </div>
        )}

        {phase.kind === 'done' && total > 0 && (
          <div className="space-y-6">
            {headerCount && <p className="text-xs text-slate-500">{headerCount}</p>}

            {/* Type filter — narrow to a single lane. */}
            {allGroups.length > 1 && (
              <div className="flex flex-wrap gap-2" role="tablist" aria-label="Filter by type">
                <button
                  onClick={() => setTypeFilter(null)}
                  aria-pressed={typeFilter === null}
                  className={`rounded-full border px-3 py-1 text-xs transition-colors ${
                    typeFilter === null
                      ? 'border-emerald-500/60 bg-emerald-500/10 text-emerald-300'
                      : 'border-slate-700 bg-slate-800/60 text-slate-400 hover:text-white'
                  }`}
                >
                  All ({total})
                </button>
                {allGroups.map((g) => {
                  const Icon = TYPE_ICON[g.type];
                  const active = typeFilter === g.type;
                  return (
                    <button
                      key={g.type}
                      onClick={() => setTypeFilter(active ? null : g.type)}
                      aria-pressed={active}
                      className={`flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs transition-colors ${
                        active
                          ? 'border-emerald-500/60 bg-emerald-500/10 text-emerald-300'
                          : 'border-slate-700 bg-slate-800/60 text-slate-400 hover:text-white'
                      }`}
                    >
                      <Icon size={12} /> {TYPE_LABEL[g.type]} ({g.results.length})
                    </button>
                  );
                })}
              </div>
            )}

            {grouped.map((group) => {
              const Icon = TYPE_ICON[group.type];
              return (
                <section key={group.type}>
                  <h2 className="mb-2 flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-slate-400">
                    <Icon size={14} className="text-emerald-400" /> {group.label}
                    <span className="text-slate-600">({group.results.length})</span>
                  </h2>
                  <ul className="space-y-1.5">
                    {group.results.map((r) => (
                      <li key={`${r.type}-${r.id}`}>
                        <Link href={r.href}
                          className="group flex items-start gap-3 rounded-lg border border-slate-800 bg-slate-900 px-4 py-3 hover:border-emerald-500/40 hover:bg-slate-800/60 transition-colors">
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-medium text-white">{r.title}</p>
                            <p className="truncate text-xs text-slate-400">{r.subtitle}</p>
                            {r.headline && r.headline.length > 0
                              ? <Headline segments={r.headline} />
                              : r.snippet && <p className="mt-0.5 truncate text-xs text-slate-500">{r.snippet}</p>}
                          </div>
                          {r.amountCents != null && (
                            <span className="shrink-0 text-sm text-slate-300" style={{ fontFamily: 'var(--font-jetbrains, monospace)' }}>
                              {formatCents(r.amountCents)}
                            </span>
                          )}
                          <ArrowRight size={15} className="mt-0.5 shrink-0 text-slate-600 group-hover:text-emerald-400 transition-colors" />
                        </Link>
                      </li>
                    ))}
                  </ul>
                </section>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Grounded "why it matched" snippet. Each segment is quoted verbatim from the
 * record's own text; matched spans render highlighted so the user can see the
 * evidence for the hit (the ts_headline-equivalent, computed server-side).
 */
function Headline({ segments }: { segments: HeadlineSegment[] }) {
  return (
    <p className="mt-0.5 truncate text-xs text-slate-500">
      {segments.map((s, i) =>
        s.hit
          ? <mark key={i} className="rounded bg-emerald-500/20 px-0.5 text-emerald-200">{s.text}</mark>
          : <span key={i}>{s.text}</span>,
      )}
    </p>
  );
}

/** Local cents→USD formatter (mirrors formatMoney; keeps the page free of server imports). */
function formatCents(cents: number): string {
  const v = Number(cents) / 100;
  const f = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Math.abs(v));
  return v < 0 ? `(${f})` : f;
}
