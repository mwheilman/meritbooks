/**
 * The toast stack — a tiny external store (useSyncExternalStore-compatible).
 * Ported from Books hooks/use-toast.ts, plus an undo action.
 *
 * Copy rule (§1.2): the toast repeats the button's verb — "Approve 3" →
 * toast("Approved 3"). Errors say what happened and what to do.
 */

export type ToastTone = 'info' | 'neg';

export interface ToastAction {
  label: string;
  onClick: () => void | Promise<void>;
}

export interface ToastItem {
  id: string;
  message: string;
  tone: ToastTone;
  /** A quiet action button ("Ask to reopen"). */
  action?: ToastAction;
  /** Undo: renders "Undo ⌘Z" and binds ⌘Z while this is the newest undoable toast. */
  undo?: () => void | Promise<void>;
  /** ms before it leaves. 0 = until dismissed. */
  duration: number;
  createdAt: number;
}

export interface ToastOptions {
  tone?: ToastTone;
  action?: ToastAction;
  undo?: () => void | Promise<void>;
  duration?: number;
}

type Listener = () => void;

export interface ToastStore {
  show(message: string, opts?: ToastOptions): string;
  dismiss(id: string): void;
  clear(): void;
  getSnapshot(): ReadonlyArray<ToastItem>;
  subscribe(listener: Listener): () => void;
}

/** Max toasts on screen; older ones leave first. */
export const TOAST_LIMIT = 3;

export function createToastStore(opts: { now?: () => number; setTimer?: (fn: () => void, ms: number) => unknown; clearTimer?: (t: unknown) => void } = {}): ToastStore {
  const now = opts.now ?? (() => Date.now());
  const setTimer = opts.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((t: unknown) => clearTimeout(t as ReturnType<typeof setTimeout>));
  let items: ReadonlyArray<ToastItem> = [];
  let seq = 0;
  const timers = new Map<string, unknown>();
  const listeners = new Set<Listener>();
  const emit = () => listeners.forEach((l) => l());

  function dismiss(id: string) {
    const t = timers.get(id);
    if (t !== undefined) clearTimer(t);
    timers.delete(id);
    const next = items.filter((i) => i.id !== id);
    if (next.length !== items.length) {
      items = next;
      emit();
    }
  }

  function show(message: string, o: ToastOptions = {}): string {
    const id = `t${++seq}`;
    const tone = o.tone ?? 'info';
    // Undoable and error toasts stay long enough to act on.
    const duration = o.duration ?? (o.undo || tone === 'neg' ? 8000 : 4000);
    const item: ToastItem = { id, message, tone, action: o.action, undo: o.undo, duration, createdAt: now() };
    let next = [...items, item];
    while (next.length > TOAST_LIMIT) {
      const old = next[0];
      if (old) {
        const t = timers.get(old.id);
        if (t !== undefined) clearTimer(t);
        timers.delete(old.id);
      }
      next = next.slice(1);
    }
    items = next;
    if (duration > 0) timers.set(id, setTimer(() => dismiss(id), duration));
    emit();
    return id;
  }

  return {
    show,
    dismiss,
    clear: () => {
      timers.forEach((t) => clearTimer(t));
      timers.clear();
      items = [];
      emit();
    },
    getSnapshot: () => items,
    subscribe: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
}

/** The app-wide store. */
export const toastStore: ToastStore = createToastStore();

/**
 * Show a toast. toast('Approved 3 · posted to Heartland', { undo: () => api.unapprove(ids) })
 * Errors: toast.error("Couldn't post 1. September is soft-closed for Clive.", { action })
 */
export function toast(message: string, opts?: ToastOptions): string {
  return toastStore.show(message, opts);
}
toast.error = (message: string, opts?: Omit<ToastOptions, 'tone'>): string => toastStore.show(message, { ...opts, tone: 'neg' });
toast.dismiss = (id: string): void => toastStore.dismiss(id);
