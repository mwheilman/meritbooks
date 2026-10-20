'use client';

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { createHotkeyRegistry, type HotkeyBinding, type HotkeyEvent, type HotkeyRegistry } from './registry';

const HotkeyContext = createContext<HotkeyRegistry | null>(null);

let fallback: { registry: HotkeyRegistry; detach: (() => void) | null } | null = null;

/** The app's registry, or a lazily attached module singleton when no provider is mounted. */
function fallbackRegistry(): HotkeyRegistry {
  if (!fallback) fallback = { registry: createHotkeyRegistry(), detach: null };
  if (!fallback.detach && typeof window !== 'undefined') fallback.detach = fallback.registry.attach(window);
  return fallback.registry;
}

export interface HotkeyProviderProps {
  children: ReactNode;
  /** Inject a registry (tests, storybooks). Default: one per provider. */
  registry?: HotkeyRegistry;
}

/** Mount once at the app root. Owns the only keydown listener. */
export function HotkeyProvider({ children, registry }: HotkeyProviderProps) {
  const [reg] = useState<HotkeyRegistry>(() => registry ?? createHotkeyRegistry());
  useEffect(() => reg.attach(window), [reg]);
  return <HotkeyContext.Provider value={reg}>{children}</HotkeyContext.Provider>;
}

export function useHotkeyRegistry(): HotkeyRegistry {
  return useContext(HotkeyContext) ?? fallbackRegistry();
}

export interface UseHotkeyOptions extends Omit<HotkeyBinding, 'chord' | 'handler'> {
  /** false unregisters (e.g. while a list is loading, or a second instance on the page). */
  enabled?: boolean;
}

/**
 * Bind a chord for the lifetime of the component. The latest handler is used
 * without re-registering. A second live binding of the same chord throws in
 * development — see registry.ts.
 */
export function useHotkey(chord: string | null | undefined, handler: (e: HotkeyEvent) => void | boolean, options: UseHotkeyOptions = {}): void {
  const registry = useHotkeyRegistry();
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  const whenRef = useRef(options.when);
  whenRef.current = options.when;
  const { enabled = true, description, owner, allowInInputs } = options;
  useEffect(() => {
    if (!enabled || !chord) return undefined;
    return registry.register({
      chord,
      description,
      owner,
      allowInInputs,
      when: () => (whenRef.current ? whenRef.current() : true),
      handler: (e) => handlerRef.current(e),
    });
  }, [registry, chord, enabled, description, owner, allowInInputs]);
}
