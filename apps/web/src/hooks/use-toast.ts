'use client';

import { useState, useEffect, useCallback, useRef } from 'react';

export interface Toast {
  id: string;
  type: 'success' | 'error';
  message: string;
}

type Listener = () => void;

// Module-level state so all consumers share the same toast stack
let toasts: Toast[] = [];
let nextId = 0;
const listeners = new Set<Listener>();

function emit() {
  listeners.forEach((fn) => fn());
}

export function addToast(type: Toast['type'], message: string, duration?: number) {
  const id = String(++nextId);
  toasts = [...toasts, { id, type, message }];
  emit();

  const ms = duration ?? (type === 'success' ? 4000 : 8000);
  setTimeout(() => {
    toasts = toasts.filter((t) => t.id !== id);
    emit();
  }, ms);
}

export function removeToast(id: string) {
  toasts = toasts.filter((t) => t.id !== id);
  emit();
}

/**
 * Subscribe to the global toast stack.
 * Returns the current list of toasts, re-rendering on changes.
 */
export function useToast() {
  const [, setTick] = useState(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    const listener = () => {
      if (mountedRef.current) setTick((t) => t + 1);
    };
    listeners.add(listener);
    return () => {
      mountedRef.current = false;
      listeners.delete(listener);
    };
  }, []);

  return {
    toasts,
    addToast: useCallback(addToast, []),
    removeToast: useCallback(removeToast, []),
  };
}
