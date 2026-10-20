'use client';

import { useCallback, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { cx } from '../cx';
import { useHotkey } from '../hotkeys/HotkeyProvider';
import { Button } from '../primitives/Button';
import { useMounted } from './focus';
import { toastStore, type ToastItem, type ToastStore } from './toast-store';

const EMPTY: ReadonlyArray<ToastItem> = [];

/** Subscribe to the toast stack. */
export function useToasts(store: ToastStore = toastStore): ReadonlyArray<ToastItem> {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, () => EMPTY);
}

function ToastView({ item, store }: { item: ToastItem; store: ToastStore }) {
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => void | Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
      store.dismiss(item.id);
    }
  };
  return (
    <div className={cx('toast', item.tone === 'neg' && 'toast--neg')} role={item.tone === 'neg' ? 'alert' : undefined}>
      <span className="toast-mark" aria-hidden="true" />
      <span>{item.message}</span>
      {item.undo && (
        <Button variant="quiet" chord="mod+z" disabled={busy} onClick={() => void run(item.undo as () => void | Promise<void>)}>
          Undo
        </Button>
      )}
      {item.action && (
        <Button variant="quiet" disabled={busy} onClick={() => void run((item.action as NonNullable<ToastItem['action']>).onClick)}>
          {item.action.label}
        </Button>
      )}
      {!item.undo && !item.action && item.duration === 0 && (
        <Button variant="quiet" iconOnly icon="x" aria-label="Dismiss" onClick={() => store.dismiss(item.id)} />
      )}
    </div>
  );
}

/**
 * .toast-region — Midnight toasts, bottom-center above the keybar. Mount once
 * (root layout). ⌘Z undoes the newest undoable toast.
 */
export function ToastRegion({ store = toastStore }: { store?: ToastStore }) {
  const mounted = useMounted();
  const items = useToasts(store);
  const newestUndo = [...items].reverse().find((t) => t.undo);
  const undo = useCallback(() => {
    if (!newestUndo?.undo) return false;
    const fn = newestUndo.undo;
    store.dismiss(newestUndo.id);
    void fn();
    return true;
  }, [newestUndo, store]);
  // allowInInputs false: inside a text field ⌘Z stays the field's own undo.
  useHotkey('mod+z', undo, { enabled: !!newestUndo, allowInInputs: false, owner: 'ToastRegion', description: 'Undo the last action' });
  if (!mounted) return null;
  return createPortal(
    <div className="toast-region" role="region" aria-label="Notifications" aria-live="polite" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
      {items.map((t) => (
        <ToastView key={t.id} item={t} store={store} />
      ))}
    </div>,
    document.body,
  );
}
