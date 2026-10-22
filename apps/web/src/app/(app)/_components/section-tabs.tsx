'use client';

/**
 * In-page section tabs for consolidated parent screens (Banking & Cash, Accounting),
 * drawn as the kit's 40px underline tabs (merit-ui `.tabs`): the selected tab in
 * Midnight 600 over an Electric rule. Arrow keys move between tabs.
 *
 * The active tab is mirrored into the `?tab=` query param so retired standalone routes
 * can redirect straight into their new tab home (e.g. /covenants → /debt?tab=covenants).
 * `useSectionTab` reads the initial tab from the URL, so callers must render the shell
 * inside a <Suspense> boundary (Next 14 requirement for useSearchParams).
 */

import { useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useSearchParams } from 'next/navigation';

export interface SectionTab {
  id: string;
  label: string;
  /** Accepted for compatibility; kit tabs are text-only. */
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
  const refs = useRef(new Map<string, HTMLButtonElement>());
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    const i = tabs.findIndex((t) => t.id === active);
    let next: SectionTab | undefined;
    if (e.key === 'ArrowRight') next = tabs[(i + 1) % tabs.length];
    else if (e.key === 'ArrowLeft') next = tabs[(i - 1 + tabs.length) % tabs.length];
    else if (e.key === 'Home') next = tabs[0];
    else if (e.key === 'End') next = tabs[tabs.length - 1];
    if (!next) return;
    e.preventDefault();
    onChange(next.id);
    refs.current.get(next.id)?.focus();
  };
  return (
    <div className={['tabs', 'mb-section-tabs', className].filter(Boolean).join(' ')} role="tablist">
      {tabs.map((t) => (
        <button
          key={t.id}
          ref={(el) => {
            if (el) refs.current.set(t.id, el);
            else refs.current.delete(t.id);
          }}
          type="button"
          role="tab"
          className="tab"
          aria-selected={active === t.id}
          tabIndex={active === t.id ? 0 : -1}
          onClick={() => onChange(t.id)}
          onKeyDown={onKeyDown}
        >
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
