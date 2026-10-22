'use client';

import { ToastRegion } from '@meritbooks/merit-ui';

/**
 * The app's toast surface, on merit-ui (Redesign R1): Midnight toasts bottom-centre,
 * verb-first copy, ⌘Z undo when a toast offers it. `addToast()` (hooks/use-toast)
 * and merit-ui `toast()` both land here. Mount once (the Books shell does).
 */
export function ToastContainer() {
  return <ToastRegion />;
}
