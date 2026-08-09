'use client';

/**
 * In-page section tabs for consolidated parent screens (Banking & Cash, Accounting).
 * Reuses the existing consolidation/reconciliation in-page tab look (pill row, brand
 * accent for the active tab) so merged screens feel authored, not bolted together.
 *
 * The active tab is mirrored into the `?tab=` query param so retired standalone routes
 * can redirect straight into their new tab home (e.g. /covenants → /debt?tab=covenants).
 * `useSectionTab` reads the initial tab from the URL, so callers must render the shell
 * inside a <Suspense> boundary (Next 14 requirement for useSearchParams).
 */

import { useState, type ReactNode } from 'react';
import { useSearchParams } from 'next/navigation';
import { clsx } from 'clsx';

export interface SectionTab {
  id: string;
  label: string;
  icon?: ReactNode;
}

export function SectionTabs({
  tabs,
  active,
  onChange,
  className,
}: {
  tabs: SectionTab[];
  active: string;
  onChange: (id: string) => void;
  className?: string;
}) {
  return (
    <div
      className={clsx(
        'inline-flex items-center gap-1 rounded-lg border border-slate-800 bg-surface-900 p-1',
        className,
      )}
      role="tablist"
    >
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          aria-selected={active === t.id}
          onClick={() => onChange(t.id)}
          className={clsx(
            'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
            active === t.id ? 'bg-brand-500 text-white' : 'text-slate-400 hover:text-slate-200',
          )}
        >
          {t.icon}
          {t.label}
        </button>
      ))}
    </div>
  );
}

/**
 * Tab state seeded from `?tab=` and kept in sync with the URL (via replaceState so it
 * doesn't stack history). Returns the active id and a setter.
 */
export function useSectionTab<T extends string>(valid: readonly T[], fallback: T): readonly [T, (id: string) => void] {
  const params = useSearchParams();
  const fromUrl = params.get('tab');
  const [tab, setTab] = useState<T>(
    fromUrl && (valid as readonly string[]).includes(fromUrl) ? (fromUrl as T) : fallback,
  );

  // Setter is typed `(id: string)` so it drops straight into <SectionTabs onChange>;
  // callers only ever pass ids from `valid`, so the cast is safe.
  const set = (id: string) => {
    setTab(id as T);
    if (typeof window !== 'undefined') {
      const url = new URL(window.location.href);
      url.searchParams.set('tab', id);
      window.history.replaceState(null, '', url.toString());
    }
  };

  return [tab, set] as const;
}
