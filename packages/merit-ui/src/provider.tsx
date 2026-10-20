'use client';

import { createContext, forwardRef, useContext, useMemo, type AnchorHTMLAttributes, type ReactNode, type Ref } from 'react';
import { HotkeyProvider } from './hotkeys/HotkeyProvider';
import type { HotkeyRegistry } from './hotkeys/registry';

export type LinkProps = AnchorHTMLAttributes<HTMLAnchorElement> & { href: string };
/**
 * Anything that renders an anchor from { href, …anchor props, ref } —
 * next/link qualifies (test/link-compat.test.ts proves it at compile time).
 */
export type LinkComponent = (props: LinkProps & { ref?: Ref<HTMLAnchorElement> }) => ReactNode;

interface MeritUIContextValue {
  Link: LinkComponent;
  navigate: (href: string) => void;
}

const PlainLink = forwardRef<HTMLAnchorElement, AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }>(function PlainLink(props, ref) {
  return <a ref={ref} {...props} />;
}) as unknown as LinkComponent;

const defaultNavigate = (href: string): void => {
  if (typeof window !== 'undefined') window.location.assign(href);
};

const MeritUIContext = createContext<MeritUIContextValue>({ Link: PlainLink, navigate: defaultNavigate });

export interface MeritProviderProps {
  children: ReactNode;
  /** The app's link component (next/link). Default: a plain <a>. */
  link?: LinkComponent;
  /** Client-side navigation for go-to chords (router.push). Default: location.assign. */
  navigate?: (href: string) => void;
  /** Inject a hotkey registry (tests). */
  hotkeys?: HotkeyRegistry;
}

/**
 * Root provider: the one hotkey registry, plus the app's Link and router so
 * shell components (Rail go-to keys, Crumbs, Figure links) navigate client-side.
 *
 *   <MeritProvider link={Link} navigate={router.push}>…</MeritProvider>
 */
export function MeritProvider({ children, link, navigate, hotkeys }: MeritProviderProps) {
  const value = useMemo<MeritUIContextValue>(
    () => ({ Link: link ?? PlainLink, navigate: navigate ?? defaultNavigate }),
    [link, navigate],
  );
  return (
    <MeritUIContext.Provider value={value}>
      <HotkeyProvider registry={hotkeys}>{children}</HotkeyProvider>
    </MeritUIContext.Provider>
  );
}

export function useMeritUI(): MeritUIContextValue {
  return useContext(MeritUIContext);
}

/** An anchor rendered through the app's Link component. */
export const AppLink = forwardRef<HTMLAnchorElement, AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }>(function AppLink(props, ref) {
  const { Link } = useMeritUI();
  return <Link ref={ref} {...props} />;
});
